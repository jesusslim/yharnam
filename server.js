var path = require('path');
var cookieParser = require('cookie-parser')
var express = require('express');
var session = require('express-session')
var ws = require('ws');
var minimist = require('minimist');
var url = require('url');
var kurento = require('kurento-client');
var fs    = require('fs');
var https = require('https');
var redis = require("redis");

/**
 * config
 */
var config = require('./config/config.js');

var redis_client = redis.createClient();
const REDIS_EXPIRE = 3600;

const OPTIONS_DEFAULT_WIDTH = 250;
const OPTIONS_DEFAULT_HEIGHT = 170;
const OPTIONS_DEFAULT_FRAME_RATE = 24;

function storeSession(session_id,key,value,callback){
	redis_client.get(session_id,function(error,result){
		var r = JSON.parse(result);
		if (!r) {
			r = {};
		}
		r[key] = value;
		redis_client.set(session_id, JSON.stringify(r), 'EX', REDIS_EXPIRE);
		callback(null);
	});
}

/**
 * consts
 */
const USER_TYPE_STUDENT = 1;
const USER_TYPE_TEACHER = 2;

var argv = minimist(process.argv.slice(2), {
  default: {
      as_uri: "https://localhost:8443/",
      ws_uri: "ws://localhost:8888/kurento"
  }
});

var options =
{
  key:  fs.readFileSync('keys/engine.key'),
  cert: fs.readFileSync('keys/engine.cer')
};

var app = express();
app.use(cookieParser());
var sessionHandler = session({
    secret : 'none',
    rolling : true,
    resave : true,
    saveUninitialized : true
});
app.use(sessionHandler);

var KURENTO_CLIENT = null;
var USERS = new Users();
var CANDIDATES_QUEUE = {};
var CLASSROOM = {};

function getYmd(){
	var date = new Date();
	var year = date.getFullYear();
	var month = date.getMonth()+1;
	var day = date.getDate();
	if (month < 10) {month = '0'+month;}
	if (day < 10) {day = '0'+day;}
	return year+'-'+month+'-'+day;
}

/**** USERS ****/

function Users(){
	this.users = {};
}

Users.prototype.get = function(id){
	return this.users[id];
}

Users.prototype.reg = function(user){
	this.users[user.id] = user;
	CANDIDATES_QUEUE[user.id] = {};
}

Users.prototype.unreg = function(id){
	var user = this.get(id);
	if (user) {
		delete this.users[id];
		delete CANDIDATES_QUEUE[id];
	}
}

/**** USERS END ****/

/**** USER ****/

function User(id,nickname,user_type,ws){
	this.id = id;
	this.nickname = nickname;
	this.user_type = user_type;
	this.ws = ws;
	this.sdp_offer = {};
	this.class_id = 0;
	this.options = new Options();
}

User.prototype.send = function(msg){
	this.ws.send(JSON.stringify(msg));
}

/**** USER END ****/

/**** OPTIONS ****/

function Options(){
	//server/kurento
	this.max_video_recv_band_width = 0;

	//client/webrtc
	this.mandatory = {
		maxWidth:OPTIONS_DEFAULT_WIDTH,
		maxHeight:OPTIONS_DEFAULT_HEIGHT,
		maxFrameRate:OPTIONS_DEFAULT_FRAME_RATE
	};
}

/**** OPTIONS END ****/

/**** CLASSROOM ****/

function Classroom(id){
	this.id = id;
	this.user_ids = {};
	this.pipeline = null;
	this.has_teacher = false;
	this.recorders = {};
	this.need_recording = false;
}

Classroom.prototype.join = function(user_id){
	var user = USERS.get(user_id);
	if (!user) {
		return 'user '+user_id+' not exists';
	}
	if (user.user_type == USER_TYPE_TEACHER && this.hasTeacher()) {
		return 'already has teacher';
	}
	this.user_ids[user_id] = true;
	user.class_id = this.id;
	if (user.user_type == USER_TYPE_TEACHER) {
		this.has_teacher = true;
	}
	return true;
}

Classroom.prototype.leave = function(user_id){
	if (this.user_ids[user_id]) {
		if (USERS.get(user_id).user_type == USER_TYPE_TEACHER) {
			this.has_teacher = false;
		}
		delete this.user_ids[user_id];
	}
}

Classroom.prototype.hasTeacher = function(){
	return this.has_teacher;
}

/**** CLASSROOM END ****/

/**** PIPELINE ****/

function peerName(user_id_from,user_id_to){
	if (user_id_from > user_id_to) {
		return user_id_to+'-'+user_id_from;
	}else{
		return user_id_from+'-'+user_id_to;
	}
}

function Pipeline(){
	this.pipeline = null;
	this.peers = {};
}

function Peer(){
	this.endpoints = {};
	this.user_ids = [];
	this.missing_inboundrtp_count = 0;
}

Pipeline.prototype.getPipeline = function(client,callback){
	if (this.pipeline) {
		return callback(null,this.pipeline);
	}else{
		client.create('MediaPipeline',function(error,pipeline){
			if (error) {
				return callback(error,null);
			}
			console.log('new pipeline');
			return callback(null,pipeline);
		});
	}
}

Pipeline.prototype.create = function(caller_id,callee_id,ws,callback){
	var self = this;
	var peer_key = peerName(caller_id,callee_id);
	if (self.peers[peer_key]) {
		return callback(null);
	}else{
		getKurentoClient(function(error,client){
			if (error) {
				return callback(error);
			}

			self.getPipeline(client,function(error,pipeline){
				if (error) {
					return callback(error);
				}
				
				self.pipeline = pipeline;

				if (config.latency) {
					pipeline.setLatencyStats(true);
				}

				//create peer
				var peer = new Peer();
				console.log('new peer for '+caller_id+' and '+callee_id);
				pipeline.create('WebRtcEndpoint',function(error,caller_end_point){
					if (error) {
						return callback(error);
					}

					//mario
					// if(USERS.get(caller_id).user_type == USER_TYPE_TEACHER){
					// 	pipeline.create('FaceOverlayFilter', function(error, faceOverlayFilter) {
				 //            if (error) {
				 //                return callback(error);
				 //            }

				 //            faceOverlayFilter.setOverlayedImage(url.format(as_url) + 'img/mario-wings.png',
				 //                    -0.35, -1.2, 1.6, 1.6, function(error) {
				 //                if (error) {
				 //                    return callback(error);
				 //                }

				 //                caller_end_point.connect(faceOverlayFilter, function(error) {
					// 		        if (error) {
					// 		            return callback(error);
					// 		        }

					// 		        faceOverlayFilter.connect(caller_end_point, function(error) {
					// 		            if (error) {
					// 		                return callback(error);
					// 		            }
					// 		        });
					// 		    });

				 //            });
				 //        });
					// }
			
					var max_video_recv_band_width = USERS.get(caller_id).options.max_video_recv_band_width;
					if (max_video_recv_band_width > 0) {
						caller_end_point.setMaxVideoRecvBandwidth(max_video_recv_band_width);
					}

					// caller_end_point.setMaxVideoSendBandwidth(5);
					// caller_end_point.setMaxVideoRecvBandwidth(1);
					// no use , maybe only media element
					// caller_end_point.setMaxOutputBitrate(1,function(error){
					// 	console.log(error);
					// });
					//caller_end_point.maxOutputBitrate = 1;

					if (CANDIDATES_QUEUE[caller_id][callee_id]) {
						while(CANDIDATES_QUEUE[caller_id][callee_id].length){
							var candidate = CANDIDATES_QUEUE[caller_id][callee_id].shift();
		                    caller_end_point.addIceCandidate(candidate);
						}
					}

					caller_end_point.on('OnIceCandidate',function(event){
						var candidate = kurento.getComplexType('IceCandidate')(event.candidate);
						if (USERS.get(caller_id)) {
							USERS.get(caller_id).send({
		                        id : 'iceCandidate',
		                        candidate : candidate,
		                        user_id:callee_id
		                    });
						}
					});

					pipeline.create('WebRtcEndpoint',function(error,callee_end_point){
						if (error) {
							return callback(error);
						}

						var max_video_recv_band_width = USERS.get(callee_id).options.max_video_recv_band_width;
						if (max_video_recv_band_width > 0) {
							callee_end_point.setMaxVideoRecvBandwidth(max_video_recv_band_width);
						}

						if (CANDIDATES_QUEUE[callee_id][caller_id]) {
							while(CANDIDATES_QUEUE[callee_id][caller_id].length){
								var candidate = CANDIDATES_QUEUE[callee_id][caller_id].shift();
		                    	callee_end_point.addIceCandidate(candidate);
							}
						}

						callee_end_point.on('OnIceCandidate',function(event){
							var candidate = kurento.getComplexType('IceCandidate')(event.candidate);
							if (USERS.get(callee_id)) {
			                    USERS.get(callee_id).send({
			                        id : 'iceCandidate',
			                        candidate : candidate,
			                        user_id:caller_id
			                    });
							}
						});

						caller_end_point.connect(callee_end_point,function(error){
							if (error) {
	                            return callback(error);
	                        }

	                        callee_end_point.connect(caller_end_point,function(error){
	                        	if (error) {
	                            	return callback(error);
	                        	}
	                        });

	                        peer.endpoints[caller_id] = caller_end_point;
	                        peer.endpoints[callee_id] = callee_end_point;
	                        peer.user_ids.push(caller_id);
	                        peer.user_ids.push(callee_id);
	                        self.peers[peer_key] = peer;

	                        //recording
	                        var class_id = USERS.get(caller_id).class_id;
	                        var class_room = CLASSROOM[class_id];
							if (class_room && class_room.need_recording) {
								if (!class_room.recorders[caller_id]) {
									var record_params = {
										uri : 'file:///tmp/yharnam/'+getYmd()+'/'+class_id+'/'+caller_id+'_'+Date.now()+'.webm'
									};
									pipeline.create("RecorderEndpoint", record_params, function(error, recorder_endpoint) {
										if (error) {
											return callback(error);
										}
										caller_end_point.connect(recorder_endpoint);
										recorder_endpoint.record();

										class_room.recorders[caller_id] = recorder_endpoint;
									});
								}
								if (!class_room.recorders[callee_id]) {
									var record_params = {
										uri : 'file:///tmp/yharnam/'+getYmd()+'/'+class_id+'/'+callee_id+'_'+Date.now()+'.webm'
									};
									pipeline.create("RecorderEndpoint", record_params, function(error, recorder_endpoint) {
										if (error) {
											return callback(error);
										}
										callee_end_point.connect(recorder_endpoint);
										recorder_endpoint.record();

										class_room.recorders[callee_id] = recorder_endpoint;											
									});
								}
							}

							//stats
							// setInterval(function(end_point){
							// 	if (end_point) {
							// 		end_point.getStats('VIDEO',function(error,stats){
							// 			// for(var key in stats){
							// 		 //      stat = stats[key];
							// 		 //      if(stats.type != '') continue;
							// 		 //    }
							// 			console.log('______'+Date.now()+'______');
							// 			console.log(JSON.stringify(stats));
							// 			console.log('===================');
							// 			console.log('===================');
							// 		});
							// 	}
							// },1000,caller_end_point);
						
	                        callback(null);
						});
					});
				});

			});
		});
	};

};

Pipeline.prototype.generateSdpAnswer = function(user_id,another_user_id,sdp_offer,callback){
	var peer_key = peerName(user_id,another_user_id);
	if (this.peers[peer_key]) {
		var peer = this.peers[peer_key];
		peer.endpoints[user_id].processOffer(sdp_offer,callback);
		peer.endpoints[user_id].gatherCandidates(function(error){
			if (error) {
	            return callback(error);
	        }
		});
	}else{
		return callback('peer not exists:'+peer_key);
	}
};

Pipeline.prototype.release = function(){
	if(this.pipeline) this.pipeline.release();
	this.pipeline = null;
	console.log('pipeline release');
};

function getKurentoClient(cb){
	if (KURENTO_CLIENT !== null) {
		return cb(null,KURENTO_CLIENT);
	}
	kurento(argv.ws_uri, function(error, _kurentoClient) {
        if (error) {
            var message = 'could not find media server at address ' + argv.ws_uri;
            return cb(message + ",error " + error);
        }
        KURENTO_CLIENT = _kurentoClient;
        cb(null, KURENTO_CLIENT);
    });
}

/**** PIPELINE END ****/

/**** SERVER ****/

var as_url = url.parse(argv.as_uri);
var port = as_url.port;
var server = https.createServer(options,app).listen(port,function(){
	console.log('server start at '+url.format(as_url));
});

var ws_server = new ws.Server({
	server:server,
	path:'/ludwig'
});

ws_server.on('connection',function(ws){
	var session_id = null;
	var ip = ws._socket.remoteAddress;
    var request = ws.upgradeReq;
    var response = {
        writeHead : {}
    };

    sessionHandler(request, response, function(err) {
        session_id = request.session.id;
		console.log('new connection , session id is '+session_id + ' , ip is '+ip);
		//check session logged
		
		redis_client.get(session_id,function(error,result){
			sess_stored = JSON.parse(result);
			if (sess_stored && sess_stored.user_id > 0) {
				ws.send(JSON.stringify({
	                id : 'auto',
	                data: sess_stored
	            }));
			}
		});
    });

	ws.on('error',function(error){
		console.log('connection error on session '+session_id);
		stop(ws);
	});

	ws.on('close',function(){
		console.log('connection '+session_id + ' is closed');
		stop(ws);
	});

	ws.on('message',function(message){
		var msg = JSON.parse(message);
		//console.log('connection '+ session_id + ' receive msg '+message);

		switch(msg.id){
			case 'reg':
				reg(session_id,msg.user_id,msg.user_type,msg.nickname,ws);
				break;

			case 'join':
				join_class(session_id,msg.class_id,msg.from,ws);
				break;

			case 'call':
            	call(session_id, msg.class_id, msg.from, msg.to,msg.sdp_offer);
            	break;

            case 'incomingCallResp':
            	incomingCallResp(session_id,msg.class_id,msg.from,msg.to,msg.status,msg.sdp_offer,ws);
            	break;

            case 'stop':
            	stop(ws);
            	break;

            case 'onIceCandidate':
            	onIceCandidate(session_id,msg.class_id,msg.user_id,msg.to,msg.candidate);
            	break;

            case 'reset':
            	reset(session_id,msg);
            	break;

			default:
	            ws.send(JSON.stringify({
	                id : 'error',
	                message : 'Invalid message ' + message
	            }));
            break;
		}
	});

});

/**
 * reg
 * @param  {[type]}   session_id [description]
 * @param  {[type]}   user_id    [description]
 * @param  {[type]}   user_type  [description]
 * @param  {[type]}   nickname   [description]
 * @param  {[type]}   ws         [description]
 * @return {[type]}              [description]
 */
function reg(session_id,user_id,user_type,nickname,ws){
	function err(error){
		ws.send(JSON.stringify({id:'regResp',status:-1,msg:error}));
	}

	if (!user_id) {
		return err('user_id empty');
	}

	if (!user_type) {
		return err('user type empty');
	}

	if (USERS.get(user_id)) {
		//t
		stopUser(user_id);
	}

	USERS.reg(new User(user_id,nickname,user_type,ws));
	var req = ws.upgradeReq;
	req.session.user_id = user_id;
	req.session.user_type = user_type;
	storeSession(session_id,'user_id',user_id,function(){
		storeSession(session_id,'user_type',user_type,function(){});
	});
	try{
		ws.send(JSON.stringify({id:'regResp',status:1}));
	}catch(exception){
		return err(exception);
	}
}

function join_class(session_id,class_id,user_id,ws){
	var caller = USERS.get(user_id);
	function err(error){
		if (caller) {
			caller.send({id:'joinResp',status:-1,msg:error});
		}
	};
	var class_room = CLASSROOM[class_id];
	if (!class_room) {
		class_room = new Classroom(class_id);
		CLASSROOM[class_id] = class_room;
	};
	user_ids = class_room.user_ids;
	var others = new Array();
	Object.keys(user_ids).forEach(function(user_id_in_class){
		if (user_id_in_class == user_id){
			//do nothing
		}else{
			if (USERS.get(user_id_in_class)) {
				var other_user = USERS.get(user_id_in_class);
				others.push({
					user_id:user_id_in_class,
					user_type:other_user.user_type
				});
			};
		}
	});
	if (others.length >= config.max_user_count) {
		return err('max user num is '+config.max_user_count);
	};
	var r = class_room.join(user_id);
	if (r !== true) {
		return err(r);
	}
	var req = ws.upgradeReq;
	req.session.class_id = class_id;
	storeSession(session_id,'class_id',class_id,function(){});
	var message  = {
        id: 'joinResp',
        status: 1,
        others:others,
        class_id:class_id,
        options:caller.options
    };
    if (caller) {
	    caller.send(message);
    }
};

function call(session_id,class_id,user_id,to_user_id,sdp_offer){
	clearCandidatesQueue(user_id);
	
	var caller = USERS.get(user_id);
	function err(error){
		if (caller) {
			caller.send({id:'callResp',status:-1,msg:error,class_id:class_id,to:to_user_id,user_id:to_user_id});			
		}
	}
	var class_room = CLASSROOM[class_id];
	if (!class_room) {
		return err('class room '+class_id+' not exist.');
	}
	if (to_user_id == user_id) {
		//do nothing
	}else{
		//connect
		if (USERS.get(to_user_id)) {
			var callee = USERS.get(to_user_id);
			caller.sdp_offer[to_user_id] = sdp_offer;
			var message = {
	        	id: 'incomingCall',
	        	from: user_id,
	        	user_id:user_id,
	        	user_type:caller.user_type,
	        	class_id:class_id
	    	};
	    	try{
	    		return callee.send(message);
	    	}catch(exception){
	    		return err(exception);
	    	}
		}else{
			return err('user '+to_user_id+' not exists.');
		}
	}
};

function incomingCallResp(session_id,class_id,from,to,status,sdp_offer,ws){
	clearCandidatesQueue(from);
	//
	function err(error){
		console.log('incomingCallResp ERROR:'+error);
		if (pipeline) {
			pipeline.release();
		}
		if (caller) {
			caller.send({
				id:'callResp',
				status:-1,
				msg:error,
				from:from,
				user_id:from,
				class_id:class_id,
				user_type:callee.user_type
			});
		}
		callee.send({
			id:'stopCom',
			from:to,
			user_id:to,
			class_id:class_id,
			user_type:caller.user_type
		});
	}

	var callee = USERS.get(from);
	if(!callee){
		return err('unknow callee '+from);
	}
	var caller = USERS.get(to);
	if(!caller){
		return err('unknow caller '+to);
	}

	classroom = CLASSROOM[class_id];

	if (status == 1) {
		if (classroom.pipeline) {
			pipeline = classroom.pipeline;
		}else{
			var pipeline = new Pipeline();
			classroom.pipeline = pipeline;
		}
		pipeline.create(to,from,ws,function(error){
			if (error) {
				return err(error);
			}

			pipeline.generateSdpAnswer(to,from,caller.sdp_offer[from],function(error,caller_sdp_answer){
				if (error) {
					return err(error);
				}

				pipeline.generateSdpAnswer(from,to,sdp_offer,function(error,callee_sdp_answer){
					if (error) {
						return err(error);
					}

					var message = {
						id:'startCom',
						sdp_answer:callee_sdp_answer,
						from:to,
						user_id:to,
						class_id:class_id,
						user_type:caller.user_type
					};
					callee.send(message);

					var message = {
						id:'callResp',
						sdp_answer:caller_sdp_answer,
						status:1,
						from:from,
						user_id:to,
						class_id:class_id,
						user_type:callee.user_type
					};
					caller.send(message);
				});

			});
		});
	}else{
		caller.send({
			id:'callResp',
			status:-1,
			msg:'user '+from+' declined',
			from:from,
			user_id:from,
			class_id:class_id,
			user_type:callee.user_type
		});
	}
};

function onIceCandidate(session_id,class_id,user_id,to,_candidate){
	var candidate = kurento.getComplexType('IceCandidate')(_candidate);
    var user = USERS.get(user_id);
    var classroom = CLASSROOM[class_id];
    var peer_key = peerName(user_id,to);
    if (classroom && classroom.pipeline && classroom.pipeline.peers[peer_key] && classroom.pipeline.peers[peer_key].endpoints[user_id]) {
    	classroom.pipeline.peers[peer_key].endpoints[user_id].addIceCandidate(candidate);
    }else{
    	if (!CANDIDATES_QUEUE[user_id][to]) {
    		CANDIDATES_QUEUE[user_id][to] = [];
    	}
    	CANDIDATES_QUEUE[user_id][to].push(candidate);
    }
};

function stopUser(user_id){
	if (!user_id) {return true;}

	var user = USERS.get(user_id);
	if (!user) {return true;}

	var class_id = user.class_id;
	var classroom = CLASSROOM[class_id];
	if (!classroom) {return true;}

	//remove user from class
	classroom.leave(user_id);			

	stopEndpoints(classroom,user_id,user);

	USERS.unreg(user_id);

	console.log('stop '+user_id);

	user.ws.close();
}

function stopEndpoints(classroom,user_id,user){
		//stop recording
	if (classroom.need_recording && classroom.recorders[user_id]) {
		classroom.recorders[user_id].stop();
		delete classroom.recorders[user_id];
	}

	//release pipeline
	peers = classroom.pipeline.peers;
	Object.keys(peers).forEach(function(peer_key){
		var peer = peers[peer_key];
		var user_ids = peer.user_ids;
		for (var i = 0; i < user_ids.length; i++) {
			if (user_ids[i] == user_id) {
				delete peers[peer_key];
				//send msg
				for (var j = 0; j < user_ids.length; j++) {
					if (user_ids[j] != user_id) {
						if (USERS.get(user_ids[j])) {
							USERS.get(user_ids[j]).send({
								id:'stopCom',
								msg:'remote user leave',
								user_id:user_id
							});
							// try{
							// 	user.send({
							// 		id:'stopCom',
							// 		msg:'u leave',
							// 		user_id:user_id
							// 	});
							// }catch(e){

							// }
						}
					}
				}
				break;
			}
		}
	});

	//empty class remove pipeline
	if (Object.keys(classroom.pipeline.peers).length <= 0) {
		classroom.pipeline.release();
		classroom.pipeline = null;
	}
}

function stop(ws){
	var req = ws.upgradeReq;
	var user_id = req.session.user_id;
	return stopUser(user_id);
}

function reconnect(user_id){
	var user = USERS.get(user_id);
	if (user) {
		var class_id = user.class_id;
		var class_room = CLASSROOM[class_id];
		if (class_room) {
			stopEndpoints(class_room,user_id,user);
			user_ids = class_room.user_ids;
			var others = [];
			Object.keys(user_ids).forEach(function(user_id_in_class){
				if (user_id_in_class == user_id){
					//do nothing
				}else{
					if (USERS.get(user_id_in_class)) {
						var other_user = USERS.get(user_id_in_class);
						others.push({
							user_id:user_id_in_class,
							user_type:other_user.user_type
						});
					};
				}
			});
			var message  = {
		        id: 'joinResp',
		        status: 1,
		        others:others,
		        class_id:class_id,
		        options:user.options
		    };
		    user.send(message);
		}
	}
}

function reset(session_id,data){
	var user_id = data.user_id;
	var max_video_recv_band_width = Number(data.max_video_recv_band_width);
	var width = Number(data.width);
	var height = Number(data.height);
	var frame_rate = Number(data.frame_rate);
	var user = USERS.get(user_id);
	if (user) {
		var class_id = user.class_id;
		var class_room = CLASSROOM[class_id];
		if (class_room) {
			stopEndpoints(class_room,user_id,user);
			user_ids = class_room.user_ids;
			user.options.max_video_recv_band_width = max_video_recv_band_width;
			if (width > 0) {
				user.options.mandatory.maxWidth = width;
			}
			if (height > 0) {
				user.options.mandatory.maxHeight = height;
			}
			if (frame_rate > 0) {
				user.options.mandatory.maxFrameRate = frame_rate;
			}
			var others = [];
			Object.keys(user_ids).forEach(function(user_id_in_class){
				if (user_id_in_class == user_id){
					//do nothing
				}else{
					if (USERS.get(user_id_in_class)) {
						var other_user = USERS.get(user_id_in_class);
						others.push({
							user_id:user_id_in_class,
							user_type:other_user.user_type
						});
					};
				}
			});
			var message  = {
		        id: 'joinResp',
		        status: 1,
		        others:others,
		        class_id:class_id,
		        options:user.options
		    };
		    user.send(message);
		}
	}
}

//TODO:
function clearCandidatesQueue(user_id) {
	return true;
    if (CANDIDATES_QUEUE[user_id]) {
        CANDIDATES_QUEUE[user_id] = {};
    }
}

if (config.missing_inboundrtp_check_intval > 0) {
	var BreakException = {};
	setInterval(function(){
		Object.keys(CLASSROOM).forEach(function(class_id){
			var room = CLASSROOM[class_id];
			var pipeline = room.pipeline;
			var class_break = false;
			if (pipeline) {
				try{
					Object.keys(pipeline.peers).forEach(function(peer_key){
						if (class_break) {
							throw BreakException;
						}
						var peer = pipeline.peers[peer_key];
						try{
							Object.keys(peer.endpoints).forEach(function(user_key){
								var end_point = peer.endpoints[user_key];
								if (end_point) {
									end_point.getStats('VIDEO',function(error,stats){
										var has_in = false;
										if (!error) {
											Object.keys(stats).forEach(function(id){
												if (stats[id].type == 'inboundrtp') {
													has_in = true;
												}
											});
										}
										if (!has_in || error) {
											peer.missing_inboundrtp_count ++;
											if (peer.missing_inboundrtp_count >= config.missing_inboundrtp_times) {
												console.log('missing inboundrtp reconnect:user '+user_key);
												reconnect(user_key);
												class_break = true;
											}
											throw BreakException;
										}
									});
								}
							});
						}catch(e){

						}
					});
				}catch(e){

				}
			}
		});
	},config.missing_inboundrtp_check_intval*1000);
}

setInterval(function(){
	console.log('~~~~~ STATS ~~~~~');
	Object.keys(CLASSROOM).forEach(function(class_id){
		var room = CLASSROOM[class_id];
		var pipeline = room.pipeline;
		if (pipeline) {
			Object.keys(pipeline.peers).forEach(function(peer_key){
				var peer = pipeline.peers[peer_key];
				Object.keys(peer.endpoints).forEach(function(user_key){
					var end_point = peer.endpoints[user_key];
					if (end_point) {
						end_point.getStats('VIDEO',function(error,stats){
							console.log('___CLASS:'+class_id+'__PEER:'+peer_key+'__USER:'+user_key+'__'+Date.now()+'______');
							console.log(JSON.stringify(stats));
							console.log('===================');
						});
					}
				});
			});
		}
	});
},5000);

app.use(express.static(path.join(__dirname, 'static')));