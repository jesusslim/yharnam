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

const OPTIONS_DEFAULT_WIDTH = 320;
const OPTIONS_DEFAULT_HEIGHT = 240;
const OPTIONS_DEFAULT_FRAME_RATE = 15;

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

function User(id,nickname,ws){
	this.id = id;
	this.nickname = nickname;
	this.ws = ws;
	this.sdp_offer = {};
	this.class_id = 0;
	this.options = new Options();

	//TEST:
	if (this.id == 1) {
		//this.options.max_video_recv_band_width = 1;
	}

	this.incomingMedia = {};
	this.outgoingMedia = null;
}

User.prototype.send = function(msg){
	console.log('send to '+this.id+' msg ' + msg.id);
	this.ws.send(JSON.stringify(msg));
}

/**** USER END ****/

/**** OPTIONS ****/

function Options(){
	//server/kurento
	this.upload_max_video_band_width = 0;
	this.download_max_video_band_width = 0;

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
	
	this.recorders = {};
	this.is_recording = false;
}

Classroom.prototype.join = function(user_id){
	var user = USERS.get(user_id);
	if (!user) {
		return 'user '+user_id+' not exists';
	}
	//already in
	if (this.user_ids[user_id] == true) {
		return true;
	}
	this.user_ids[user_id] = true;
	user.class_id = this.id;
	return true;
}

Classroom.prototype.leave = function(user_id){
	if (this.user_ids[user_id]) {
		delete this.user_ids[user_id];
	}
}

Classroom.prototype.isRecording = function(){
	return this.is_recording;
}

Classroom.prototype.isEmpty = function(){
	return this.user_ids.length <= 0;
}

function getClassroom(class_id,callback){
	var room = CLASSROOM[class_id];
    if (room == null) {
		getKurentoClient((error, kurentoClient) => {
            if (error) {
                return callback(error);
            }

            kurentoClient.create('MediaPipeline', (error, pipeline) => {
                if (error) {
                    return callback(error);
                }
                room = new Classroom(class_id);
                room.pipeline = pipeline;
                CLASSROOM[class_id] = room;
                callback(null, room);
            });
        });
    }else{
    	callback(null,room);
    }
}

/**** CLASSROOM END ****/

function getKurentoClient(callback){
	if (KURENTO_CLIENT !== null) {
		return callback(null,KURENTO_CLIENT);
	}
	kurento(argv.ws_uri, function(error, _kurentoClient) {
        if (error) {
            var message = 'could not find media server at address ' + argv.ws_uri;
            return callback(message + ",error " + error);
        }
        KURENTO_CLIENT = _kurentoClient;
        callback(null, KURENTO_CLIENT);
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
	path:'/ladymaria'
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
		
		// redis_client.get(session_id,function(error,result){
		// 	sess_stored = JSON.parse(result);
		// 	if (sess_stored && sess_stored.user_id > 0) {
		// 		ws.send(JSON.stringify({
		// 			//TODO:刷新自动重连逻辑
	 //                id : 'auto',
	 //                data: sess_stored
	 //            }));
		// 	}
		// });
    });

	ws.on('error',function(error){
		var user_id = request.session.user_id;
		console.log(user_id + ' connection error from '+ip);
		stop(user_id);
	});

	ws.on('close',function(){
		var user_id = request.session.user_id;
		console.log(user_id + 'connection '+ip + ' is closed');
		stop(user_id);
	});

	ws.on('message',function(message){
		var msg = JSON.parse(message);
		console.log('receive msg '+msg.id+' from '+ip+',sess '+session_id);
		var request = ws.upgradeReq;
	    var response = {
	        writeHead : {}
	    };

		switch(msg.id){
			case 'reg':
				console.log('reg:'+JSON.stringify(msg));
				reg(session_id,msg.user_id,msg.nickname,ws);
				break;

			case 'join':
				var user_id = request.session.user_id;
				console.log(user_id + ' join:'+JSON.stringify(msg));
				join(session_id,user_id,msg.class_id,ws);
				break;

			case 'call':
				//get sdp offer , answer
				var user_id = request.session.user_id;
				console.log(user_id + ' call:'+msg.user_id);
				call(user_id,session_id, msg.class_id, msg.user_id,msg.sdp_offer);
            	break;

            case 'stop':
	            var user_id = request.session.user_id;
	            console.log(user_id + ' stop');
            	stop(user_id);
            	break;

            case 'onIceCandidate':
            	var user_id = request.session.user_id;
            	addIceCandidate(user_id,msg.class_id,msg.user_id,msg.candidate);
            	break;

            case 'reset':
            	var user_id = request.session.user_id;
            	console.log(user_id + ' reset:'+JSON.stringify(msg));
            	reset(session_id,user_id,msg);
            	break;

            case 'record':
            	record(msg.class_id);
            	break;

            case 'mario':
            	var user_id = request.session.user_id;
            	console.log('m0');
            	mario(user_id);
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

function reg(session_id,user_id,nickname,ws){
	function err(error){
		ws.send(JSON.stringify({id:'regResp',status:-1,msg:error}));
	}

	if (!user_id) {
		return err('user_id empty');
	}

	//TODO:if user exists 
	
	USERS.reg(new User(user_id,nickname,ws));
	var req = ws.upgradeReq;
	req.session.user_id = user_id;
	storeSession(session_id,'user_id',user_id,function(){
		storeSession(session_id,'login_time',Date.now(),function(){});
	});

	try{
		ws.send(JSON.stringify({id:'regResp',status:1}));
	}catch(exception){
		return err(exception);
	}
}

function join(session_id,user_id,class_id,ws){
	var user = USERS.get(user_id);
	function err(error){
		if (user) {
			user.send({id:'joinResp',status:-1,msg:error});
		}
	};
	getClassroom(class_id,function(error,class_room){
		if (error) {
			return err(error);
		}
		user_ids = class_room.user_ids;
		var others = new Array();
		Object.keys(user_ids).forEach(function(user_id_in_class){
			if (user_id_in_class == user_id){
				//do nothing
			}else{
				if (USERS.get(user_id_in_class)) {
					//var other_user = USERS.get(user_id_in_class);
					others.push({
						user_id:user_id_in_class
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

		//endpoint
		class_room.pipeline.create('WebRtcEndpoint', function(error, outgoingMedia){
			if (error) {
				if (class_room.isEmpty()) {
					releaseRoom(class_id);
				}
            	return err(error);
        	}
        	user.outgoingMedia = outgoingMedia;

         	//upload max video band width
        	if (user.options.upload_max_video_band_width > 0) {
				user.outgoingMedia.setMaxVideoRecvBandwidth(user.options.upload_max_video_band_width);
			}


        	var iceCandidateQueue = CANDIDATES_QUEUE[user_id][user_id];
	        if (iceCandidateQueue) {
	            while (iceCandidateQueue.length) {
	                var message = iceCandidateQueue.shift();
	                user.outgoingMedia.addIceCandidate(message);
	            }
	        }

	        user.outgoingMedia.on('OnIceCandidate', function(event){
	            var candidate = kurento.register.complexTypes.IceCandidate(event.candidate);
	            var message = {
	                id: 'iceCandidate',
	                user_id:user_id,
	                candidate: candidate
	            };
	        	user.send(message);
	        });

			var req = ws.upgradeReq;
			req.session.class_id = class_id;
			storeSession(session_id,'class_id',class_id,function(){});

			Object.keys(user_ids).forEach(function(user_id_in_class){
				if (user_id_in_class == user_id){
					//do nothing
				}else{
					if (USERS.get(user_id_in_class)) {
						var other_user = USERS.get(user_id_in_class);
						var message = {
							id:'someoneComein',
							user_id:user_id,
							class_id:class_id
						};
						other_user.send(message);
					};
				}
			});

			if(class_room.isRecording()){
				recordForUser(user_id);
			}

			var message  = {
		        id: 'joinResp',
		        status: 1,
		        others:others,
		        class_id:class_id,
		        options:user.options
		    };
			user.send(message);
		});
	});
}

function call(offer_owner_id,session_id, class_id, user_id,sdp_offer){
	var user = USERS.get(offer_owner_id);
	function err(error){
		user.send({id:'callResp',status:-1,msg:error,class_id:class_id,user_id:user_id});			
	}
	getEndpointForUser(offer_owner_id,user_id,function(error,incoming){
		if (error) {
			return err(error);
		}
		incoming.processOffer(sdp_offer,function(error,sdp_answer){
			if (error) {
				return err(error);
			}
			var message = {
				id:'callResp',
				status:1,
				sdp_answer:sdp_answer,
				user_id:user_id,
				class_id:class_id
			}
			user.send(message);

			incoming.gatherCandidates(function(error){
				if (error) {
					return err(error);
				}
			});
		});
	});
}

function getEndpointForUser(offer_owner_id,user_id,callback){
	var user = USERS.get(offer_owner_id);

	if (offer_owner_id === user_id) { 
        return callback(null, user.outgoingMedia);
    }
	var class_id = user.class_id;
    var incoming = user.incomingMedia[user_id];
    if (incoming == null) {
        console.log('user : '+offer_owner_id+' create endpoint to receive video from : '+user_id);
        //create incoming endpoint
        getClassroom(class_id,function(error,classroom){
        	if(error){
        		return callback(error);
        	}
			classroom.pipeline.create('WebRtcEndpoint', function(error,incoming){
				if (error) {
					if (class_room.isEmpty()) {
						releaseRoom(class_id);
					}
					callback(error);
					return;
				}
				user.incomingMedia[user_id] = incoming;

				//download max video band width
				if (user.options.download_max_video_band_width > 0) {
					user.incomingMedia[user_id].setMaxVideoSendBandwidth(user.options.download_max_video_band_width);
				}

				var queue = CANDIDATES_QUEUE[offer_owner_id][user_id];
				if(queue){
					while(queue.length){
						var message = queue.shift();
	                	incoming.addIceCandidate(message);
					}
				}

				incoming.on('OnIceCandidate', function(event){
                    // console.log(`generate incoming media candidate: ${offer_owner_id} from ${user_id}`);
                    var candidate = kurento.register.complexTypes.IceCandidate(event.candidate);
                    user.send({
                        id: 'iceCandidate',
                        user_id: user_id,
                        candidate: candidate
                    });
                });

                var remote_user = USERS.get(user_id);
                remote_user.outgoingMedia.connect(incoming,function(error){
                	if (error) {
                        console.log(error);
                        callback(error);
                        return;
                    }
                    callback(null, incoming);
                });
			});
        });
    }
}

function addIceCandidate(sesssion_user_id,class_id,user_id,candidate){
	candidate = kurento.register.complexTypes.IceCandidate(candidate);
	var session_user = USERS.get(sesssion_user_id);
	if (sesssion_user_id == user_id) {
		if (session_user.outgoingMedia) {
			session_user.outgoingMedia.addIceCandidate(candidate);
		}else{
			if (!CANDIDATES_QUEUE[sesssion_user_id][user_id]) {
    			CANDIDATES_QUEUE[sesssion_user_id][user_id] = [];
    		}
			CANDIDATES_QUEUE[sesssion_user_id][user_id].push(candidate);
		}
	}else{
		if (session_user.incomingMedia[user_id]) {
			session_user.incomingMedia[user_id].addIceCandidate(candidate);
		}else{
			if (!CANDIDATES_QUEUE[sesssion_user_id][user_id]) {
    			CANDIDATES_QUEUE[sesssion_user_id][user_id] = [];
    		}
    		CANDIDATES_QUEUE[sesssion_user_id][user_id].push(candidate);
		}
	}
}

function stop(user_id){
	leaveRoom(user_id);
	USERS.unreg(user_id);
}

function leaveRoom(user_id){
	var user = USERS.get(user_id);
	if (!user) {
		return ;
	}
	if(user.outgoingMedia)user.outgoingMedia.release();
	for (var remote_user_id in user.incomingMedia) {
        user.incomingMedia[remote_user_id].release();
        delete user.incomingMedia[remote_user_id];
    }
	var room = CLASSROOM[user.class_id];
	if (!room){
		return ;
	}
	recordStopForUser(user_id);
	room.leave(user_id);
	Object.keys(room.user_ids).forEach(function(user_id_in_class){
		if (USERS.get(user_id_in_class)) {
			var other_user = USERS.get(user_id_in_class);
			other_user.incomingMedia[user_id].release();
			delete other_user.incomingMedia[user_id];
			var message = {
				id:'someoneLeave',
				user_id:user_id,
				class_id:user.class_id
			};
			other_user.send(message);
		};
	});
	if (room.isEmpty()) {
		releaseRoom(class_id);
	}
}

function releaseRoom(room_id){
	console.log('class room '+room_id+' release');
	var room = CLASSROOM[room_id];
	room.pipeline.release();
	delete CLASSROOM[room_id];
}

function reset(session_id,user_id,msg){
	var user = USERS.get(user_id);
	if (!user) {
		return ;
	}
	leaveRoom(user_id);
	if(msg.upload_max_video_band_width > 0){
		user.options.upload_max_video_band_width = Number(msg.upload_max_video_band_width);
	}
	if(msg.download_max_video_band_width > 0){
		user.options.download_max_video_band_width = Number(msg.download_max_video_band_width);
	}
	if(msg.width > 0){
		user.options.mandatory.maxWidth = msg.width;
	}
	if(msg.height > 0){
		user.options.mandatory.maxHeight = msg.height;
	}
	if(msg.frame_rate > 0){
		user.options.mandatory.maxFrameRate = msg.frame_rate;
	}
	join(session_id,user_id,user.class_id,user.ws);
}

// record
function record(class_id){
	var room = CLASSROOM[class_id];
	if (!room) {
		return ;
	}
	if (room.isRecording()) {
		return ;
	}
	if (!room.pipeline) {
		return ;
	}
	Object.keys(room.user_ids).forEach(function(user_id_in_class){
		if (USERS.get(user_id_in_class)) {
			var user = USERS.get(user_id_in_class);
			if (user) {
				if (!room.recorders[user_id_in_class]) {
					var record_params = {
						uri : 'file:///home/records/'+getYmd()+'/'+class_id+'/'+user_id_in_class+'_'+Date.now()+'.webm'
					};
					room.pipeline.create("RecorderEndpoint", record_params, function(error, recorder_endpoint) {
						if (error) {
							console.error(error);
							return error;
						}
						user.outgoingMedia.connect(recorder_endpoint);
						recorder_endpoint.record();
						room.recorders[user_id_in_class] = recorder_endpoint;
					});
				}
			}
		};
	});
	room.is_recording = true;
}

function recordStop(class_id){
	var room = CLASSROOM[class_id];
	if (!room) {
		return ;
	}
	if (room.isRecording()) {
		return ;
	}
	for (var user_id in room.recorders) {
        room.recorders[user_id].release();
        delete room.recorders[user_id];
    }
    room.is_recording = false;
}

function recordStopForUser(user_id){
	var user = USERS.get(user_id);
	if (!user){
		return ;
	}
	var class_id = user.class_id;
	var room = CLASSROOM[class_id];
	if (!room) {
		return ;
	}
	if (!room.isRecording()){
		return ;
	}
	if (room.recorders[user_id]){
		room.recorders[user_id].release();
        delete room.recorders[user_id];
	}
}

function recordForUser(user_id){
	var user = USERS.get(user_id);
	if (!user){
		return ;
	}
	var class_id = user.class_id;
	var room = CLASSROOM[class_id];
	if (!room) {
		return ;
	}
	if (!room.isRecording()){
		return ;
	}
	if (!room.pipeline) {
		return ;
	}
	if (!room.recorders[user_id]) {
		var record_params = {
			uri : 'file:///home/records/'+getYmd()+'/'+class_id+'/'+user_id+'_'+Date.now()+'.webm'
		};
		room.pipeline.create("RecorderEndpoint", record_params, function(error, recorder_endpoint) {
			if (error) {
				console.error(error);
				return error;
			}
			user.outgoingMedia.connect(recorder_endpoint);
			recorder_endpoint.record();
			room.recorders[user_id] = recorder_endpoint;
		});
	}
}

function getYmd(){
	var date = new Date();
	var year = date.getFullYear();
	var month = date.getMonth()+1;
	var day = date.getDate();
	if (month < 10) {month = '0'+month;}
	if (day < 10) {day = '0'+day;}
	return year+'-'+month+'-'+day;
}

function mario(user_id){
	var user = USERS.get(user_id);
	var room = CLASSROOM[user.class_id]
	console.log('m1');
	room.pipeline.create('FaceOverlayFilter', function(error, faceOverlayFilter) {
        if (error) {
        	console.log(error);
        	return error;
        }
        console.log('m2');
        faceOverlayFilter.setOverlayedImage(url.format(as_url) + 'img/mario-wings.png',
            -0.35, -1.2, 1.6, 1.6, 
            function(error) {
	            if (error) {
	            	console.log(error);
	                return error;
	            }
	            console.log('m3');
	    //         Object.keys(room.user_ids).forEach(function(user_id_in_class){
					// if (USERS.get(user_id_in_class) && user_id_in_class != user_id) {
					// 	var other_user = USERS.get(user_id_in_class);
					// 	other_user.incomingMedia[user_id].connect(faceOverlayFilter,function(error){
			  //           	if (error) {
					//         	console.error(error);
					//         	return error;
					//         }
					//         faceOverlayFilter.connect(other_user.incomingMedia[user_id],function(error){
					//         	if (error) {
					// 	        	console.error(error);
					// 	        	return error;
					// 	        }
					//         });
					//     });
					// }
	    //         });

	            user.outgoingMedia.connect(faceOverlayFilter,function(error){
	            	console.log(user.nickname+'connect to overlay');
	            	if (error) {
			        	console.log(error);
			        	return error;
			        }
			        faceOverlayFilter.connect(user.outgoingMedia,function(error){
			        	console.log('overlay connect to '+user.nickname);
			        	if (error) {
				        	console.log(error);
				        	return error;
				        }
			        });
	            });
	        }
		)
	});
}

app.use(express.static(path.join(__dirname, 'static')));


