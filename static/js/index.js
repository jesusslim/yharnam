var ws = new WebSocket('wss://' + location.host + '/ladymaria');

var USER_ID;

var CLASS_ID;

var VIDEO_BOX_SELF;

var PEERS = {};

var OPTIONS = {};

window.onload = function() {
	$('#stop').attr('disabled', true);
	$('#call').attr('disabled', true);
	VIDEO_BOX_SELF = $("#video_box_self");
	document.getElementById('submit').addEventListener('click', function() {
		register();
	});
	document.getElementById('call').addEventListener('click', function() {
		joinClass();
	});
	document.getElementById('stop').addEventListener('click', function() {
		stop();
	});
	document.getElementById('reset').addEventListener('click', function() {
		reset();
	});
	document.getElementById('snapshot').addEventListener('click', function() {
		snapshot();
	});
	document.getElementById('pic').addEventListener('click', function() {
		$("#pic").hide();
	});
	document.getElementById('record').addEventListener('click', function() {
		record();
	});
	document.getElementById('mario').addEventListener('click', function() {
		mario();
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
		case 'regResp':
			regResp(msg);
			break;
		case 'joinResp':
			joinResp(msg);
			break;
		case 'callResp':
			callResp(msg);
			break;
		case 'someoneLeave':
			someoneLeave(msg);
			break;
		case 'iceCandidate':
			PEERS[msg.user_id].addIceCandidate(msg.candidate,function(error){
				if (error) {
					console.error(error);
				}
			});
			break;
		case 'someoneComein':
			someoneComein(msg);
			break;
		default:
			console.error('Unrecognized message', msg);		
	}
}

ws.onerror = function(event){
	alert("socket error:"+JSON.stringify(event));
}

function sendMessage(message){
	var jsonMessage = JSON.stringify(message);
	console.log('Send message:'+message.id);
	//console.log('Senging message: ' + jsonMessage);
	try{
		ws.send(jsonMessage);		
	}catch(e){
		alert("socket error:"+JSON.stringify(e));
	}
}

function register() {
	var user_id = document.getElementById('user_id').value;
	USER_ID = user_id;
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
		nickname:nickname
	};
	sendMessage(message);
	$('#submit').attr('disabled', true);
}

function regResp(msg){
	if (msg.status == 1) {
		//alert('reg success');
		$("#call").attr('disabled',false);
	}else{
		alert(msg.msg);
		$('#submit').attr('disabled', false);
	}
}

function joinClass(){
	var class_id = document.getElementById('class_id').value;
	var message = {
		id : 'join',
		class_id:class_id
	};
	sendMessage(message);
	$('#call').attr('disabled', true);
	$('#stop').attr('disabled', false);
}

function stop(){
	var message = {
		id : 'stop',
		class_id:CLASS_ID
	};
	sendMessage(message);
	$('#call').attr('disabled', true);
	$('#submit').attr('disabled', false);
}

function joinResp(msg){
	if (msg.status == 1) {
		CLASS_ID = msg.class_id;
		OPTIONS = msg.options;
		send();
		for (var i = 0; i < msg.others.length; i++) {
			var to_user = msg.others[i];
			console.log('other is '+to_user.user_id);
			newBox(to_user.user_id);
			call(to_user.user_id);
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

function send(){
	var options = {
		localVideo : VIDEO_BOX_SELF.find("video")[0],
		onicecandidate : function(candidate){
			onIceCandidate(candidate,USER_ID);
		},
		mediaConstraints:{
			audio : true,
			video : OPTIONS
		}
	}
	PEERS[USER_ID] = new kurentoUtils.WebRtcPeer.WebRtcPeerSendonly(options,
		function (error) {
			if(error) {
			  return console.error(error);
			}
			this.generateOffer(function(error,offerSdp){
				if (error) {
					console.error(error);
				}
				var message = {
					id : 'call',
					user_id : USER_ID,
					class_id:CLASS_ID,
					sdp_offer:offerSdp
				};
				sendMessage(message);
			});
	});
}

function call(user_id){
	console.log('call '+user_id);

	var rmt_box = $("#video_box_"+user_id)[0];
	var rmt_vdo = $("#video_box_"+user_id).find("video")[0];
	$(rmt_box).find(".nickname").text('User '+user_id);

	//vdo
	var options = {
		remoteVideo : rmt_vdo,
		onicecandidate : function(candidate){
			onIceCandidate(candidate,user_id);
		}
	}

	PEERS[user_id] = kurentoUtils.WebRtcPeer.WebRtcPeerRecvonly(options, 
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
					user_id : user_id,
					class_id:CLASS_ID,
					sdp_offer:offerSdp
				};
				sendMessage(message);
			});
		}
	);
}

function callResp(msg){
	if (msg.status != 1) {
		console.info('call fail ' + JSON.stringify(msg.msg));
		alert(msg.msg);
	} else{
		PEERS[msg.user_id].processAnswer(msg.sdp_answer,function(error){
			if (error) {
				console.error(error);
			}
		});
	}
}

function onIceCandidate(candidate,user_id){
	sendMessage({
		id:'onIceCandidate',
		user_id:user_id,
		class_id:CLASS_ID,
		candidate:candidate
	});
}

function someoneComein(msg){
	newBox(msg.user_id);
	call(msg.user_id);
}

function someoneLeave(msg){
	leave(msg.user_id);
}

function leave(user_id){
	PEERS[user_id].dispose();
	delete PEERS[user_id];
	$("#video_box_"+user_id).remove();
}

function reset(){
	for (var user_id in PEERS) {
        leave(user_id);
    }
	sendMessage({
		id:'reset',
		user_id:USER_ID,
		upload_max_video_band_width:$('#upload_max_video_band_width').val(),
		download_max_video_band_width:$('#download_max_video_band_width').val(),
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
  	$("#pic").show();
}

function record(){
	sendMessage({
		id:'record',
		class_id:CLASS_ID
	});
}

function mario(){
	sendMessage({
		id:'mario'
	});
}