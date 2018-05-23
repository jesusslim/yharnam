var ws = new WebSocket('wss://' + location.host + '/ludwig');

const USER_TYPE_TEACHER = 2;
const USER_TYPE_STUDENT = 1;

var USER_ID = 0;
var CLASS_ID = 0;
var USER_TYPE = 0;

var VIDEO_BOX_SELF;

var PEERS = {};

var OPTIONS = {};

window.onload = function() {
	VIDEO_BOX_SELF = $("#video_box_self");
	document.getElementById('submit').addEventListener('click', function() {
		register();
	});
	document.getElementById('call').addEventListener('click', function() {
		joinClass();
	});
	document.getElementById('reset').addEventListener('click', function() {
		reset();
	});
	document.getElementById('snapshot').addEventListener('click', function() {
		snapshot();
	});
	$("#filter").change(function(){
		var cls = $("#filter").val();
		var video = VIDEO_BOX_SELF.find("video");
		video.removeClass(video.attr("filter")).addClass(cls).attr("filter",cls);
	});
}

window.onbeforeunload = function() {
	ws.close();
}

ws.onmessage = function(message){
	var msg = JSON.parse(message.data);
	console.info('Received message: ' + msg.id);

	switch(msg.id){
		case 'auto':
			auto(msg);
			break;
		case 'regResp':
			regResp(msg);
			break;
		case 'joinResp':
			joinResp(msg);
			break;
		case 'callResp':
			callResp(msg);
			break;
		case 'incomingCall':
			incomingCall(msg);
			break;
		case 'startCom':
			startCom(msg);
			break;
		case 'stopCom':
			stopCom(msg);
			break;
		case 'iceCandidate':
			PEERS[msg.user_id].addIceCandidate(msg.candidate);
			break;
		default:
			console.error('Unrecognized message', msg);		
	}

}

function sendMessage(message){
	var jsonMessage = JSON.stringify(message);
	console.log('Send message:'+message.id);
	//console.log('Senging message: ' + jsonMessage);
	ws.send(jsonMessage);
}

function register() {
	var user_id = document.getElementById('user_id').value;
	USER_ID = user_id;
	var user_type = document.getElementById('user_type').value;
	USER_TYPE = user_type;
	VIDEO_BOX_SELF.find(".nickname").text('User '+USER_ID);

	var constraints = {video: true,audio:true};

	//navigator.getUserMedia(constraints, successCallback, errorCallback);
	navigator.mediaDevices.getUserMedia(constraints).then(function(stream){
		VIDEO_BOX_SELF.find("video")[0].srcObject = stream;
	});

	var nickname = document.getElementById('nickname').value;
	var message = {
		id : 'reg',
		user_id : user_id,
		nickname:nickname,
		user_type:user_type
	};
	sendMessage(message);
	$('#submit').attr('disabled', true);
}

function successCallback(stream) {

	if (window.webkitURL) {
        VIDEO_BOX_SELF.find("video")[0].src = window.webkitURL.createObjectURL(stream);
    } else {
        VIDEO_BOX_SELF.find("video")[0].src = stream;
    }

	VIDEO_BOX_SELF.find("video")[0].play();
}

function errorCallback(error){
  	console.log("getUserMedia error: ", error);
}

function auto(msg){
	msg = msg.data;
	if (msg.class_id > 0) {
		$("#class_id").val(msg.class_id);
	}
	if (msg.user_id > 0) {
		$("#user_id").val(msg.user_id);
		$("#user_type").val(msg.user_type);
		register();
	}
}

function regResp(msg){
	if (msg.status == 1) {
		//alert('reg success');
		if ($("#class_id").val() > 0) {
			joinClass();
		}
	}else{
		alert(msg.msg);
		$('#submit').attr('disabled', false);
	}
}

function joinClass(){
	var class_id = document.getElementById('class_id').value;
	var message = {
		id : 'join',
		from : USER_ID,
		class_id:class_id
	};
	sendMessage(message);
	$('#call').attr('disabled', true);
}

function joinResp(msg){
	if (msg.status == 1) {
		CLASS_ID = msg.class_id;
		OPTIONS = msg.options;
		for (var i = 0; i < msg.others.length; i++) {
			var to_user = msg.others[i];
			newBox(to_user.user_id);
			call(to_user.user_id,to_user.user_type,i);
		}
	}else{
		alert(msg.msg);
	}
}

function newBox(user_id){
	if($("#video_box_"+user_id).length > 0){
		return true;
	}
	var box = $("#video_box_copy").clone();
	box.attr("id",'video_box_'+user_id);
	box.attr("user_id",user_id);
	$("#ground").append(box);
	box.show();
}

function call(to_user_id,user_type,index){
	console.log('call '+to_user_id + ', user_type is '+user_type);

	var rmt_box = $("#video_box_"+to_user_id)[0];
	var rmt_vdo = $("#video_box_"+to_user_id).find("video")[0];
	$(rmt_box).find(".nickname").text('User '+to_user_id);

	//vdo
	var options = {
		//localVideo : VIDEO_BOX_SELF.find("video")[0],
		remoteVideo : rmt_vdo,
		onicecandidate : function(candidate){
			onIceCandidate(candidate,to_user_id);
		},
		mediaConstraints:{
			audio : true,
			video : OPTIONS
		}
	}

	PEERS[to_user_id] = kurentoUtils.WebRtcPeer.WebRtcPeerSendrecv(options, 
		function(error) {
			if (error) {
				console.error(error);
			}

			this.generateOffer(function(error, offerSdp) {
				if (error) {
					console.error(error);
				}
				var message = {
					id : 'call',
					from : USER_ID,
					class_id:CLASS_ID,
					to:to_user_id,
					sdp_offer:offerSdp
				};
				sendMessage(message);
			});
		}
	);
}

function callResp(msg){
	if (msg.status != 1) {
		console.info('call fail ' + msg.msg);
		//TODO:recall?
	} else {
		PEERS[msg.from].processAnswer(msg.sdp_answer);
	}
}

function incomingCall(msg){
	var from_user_id = msg.from;
	var from_user_type = msg.user_type;
	var user_type = from_user_type;
	var class_id = msg.class_id;
	console.log('incoming call ,user_id '+from_user_id+' user_type '+from_user_type);

	newBox(from_user_id);

	var rmt_box = $("#video_box_"+from_user_id)[0];
	var rmt_vdo = $("#video_box_"+from_user_id).find("video")[0];
	$(rmt_box).find(".nickname").text('User '+from_user_id);

	//vdo
	var options = {
		//localVideo : VIDEO_BOX_SELF.find("video")[0],
		remoteVideo : rmt_vdo,
		onicecandidate : function(candidate){
			onIceCandidate(candidate,from_user_id);
		},
		mediaConstraints:{
			audio : true,
			video : OPTIONS
		}
	}

	PEERS[from_user_id] = kurentoUtils.WebRtcPeer.WebRtcPeerSendrecv(options,
			function(error) {
				if (error) {
					console.error(error);
				}

				this.generateOffer(function(error, offerSdp) {
					if (error) {
						console.error(error);
					}
					var response = {
						id : 'incomingCallResp',
						from : USER_ID,
						status:1,
						sdp_offer : offerSdp,
						class_id:class_id,
						to:from_user_id
					};
					sendMessage(response);
				});
			}
	);
}

function startCom(msg){
	PEERS[msg.user_id].processAnswer(msg.sdp_answer);
	
	//stats
	// setInterval(function(){
	// 	PEERS[msg.user_id].peerConnection.getStats(function(results){
	// 		results = results.result();
	// 		console.log(results);
	// 	});
	// },5000);
}

function stopCom(msg){
	console.log('stop communication by user_id : '+msg.user_id);
	console.log(PEERS);
	PEERS[msg.user_id].dispose();
}

function onIceCandidate(candidate,with_whom){
	//console.log('local candidate:'+JSON.stringify(candidate));

	sendMessage({
		id:'onIceCandidate',
		user_id:USER_ID,
		class_id:CLASS_ID,
		candidate:candidate,
		to:with_whom
	});
}

function reset(){
	sendMessage({
		id:'reset',
		user_id:USER_ID,
		max_video_recv_band_width:$('#max_video_recv_band_width').val(),
		width:$("#width").val(),
		height:$("#height").val(),
		frame_rate:$("#frame_rate").val()
	});
}

function snapshot(){
	var canvas = $("#pic")[0];
	var video = VIDEO_BOX_SELF.find("video")[0];
	canvas.width = video.videoWidth;
  	canvas.height = video.videoHeight;
  	canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
}