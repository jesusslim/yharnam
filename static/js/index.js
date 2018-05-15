var ws = new WebSocket('wss://' + location.host + '/ludwig');

const USER_TYPE_TEACHER = 2;
const USER_TYPE_STUDENT = 1;

var USER_ID = 0;
var CLASS_ID = 0;
var USER_TYPE = 0;

var VIDEO_TEACHER;
var VIDEO_STUDENT_1;
var VIDEO_STUDENT_2;
var VIDEO_SELF;

var VIDEO_BOX_TEACHER;
var VIDEO_BOX_STUDENT_1;
var VIDEO_BOX_STUDENT_2;
var VIDEO_BOX_SELF;

var TEACHERS_SIDS = [0,0];
// var TEACHER_ID = 0;
// var STUDENT_1_ID = 0;
// var STUDENT_2_ID = 0;

var PEERS = {};

var OPTIONS = {};

window.onload = function() {
	VIDEO_BOX_TEACHER = document.getElementById('video_box_teacher');
	VIDEO_BOX_STUDENT_1 = document.getElementById('video_box_student_1');
	VIDEO_BOX_STUDENT_2 = document.getElementById('video_box_student_2');
	VIDEO_TEACHER = document.getElementById('video_teacher');
	VIDEO_STUDENT_1 = document.getElementById('video_student_1');
	VIDEO_STUDENT_2 = document.getElementById('video_student_2');
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
		$(VIDEO_SELF).removeClass($(VIDEO_SELF).attr("filter")).addClass(cls).attr("filter",cls);
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
	if (USER_TYPE == USER_TYPE_TEACHER) {
		VIDEO_SELF = VIDEO_TEACHER;
		VIDEO_BOX_SELF = VIDEO_BOX_TEACHER;
	}else{
		VIDEO_SELF = VIDEO_STUDENT_2;
		VIDEO_BOX_SELF = VIDEO_BOX_STUDENT_2;
	}
	$(VIDEO_BOX_SELF).find(".nickname").text('User '+USER_ID);

	var constraints = {video: true};

	navigator.getUserMedia(constraints, successCallback, errorCallback);

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
        VIDEO_SELF.src = window.webkitURL.createObjectURL(stream);
    } else {
        VIDEO_SELF.src = stream;
    }

	VIDEO_SELF.play();
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
			call(to_user.user_id,to_user.user_type,i);
		}
	}else{
		alert(msg.msg);
	}
}

function call(to_user_id,user_type,index){
	console.log('call '+to_user_id + ', user_type is '+user_type);

	var rmt_box = VIDEO_BOX_STUDENT_1;
	var rmt_vdo = VIDEO_STUDENT_1;
	if (USER_TYPE == 1) {
		if (user_type == 2) {
			rmt_vdo = VIDEO_TEACHER;
			rmt_box = VIDEO_BOX_TEACHER;
		}
	}else{
		//i am teacher
		if (TEACHERS_SIDS[0] == 0) {
			TEACHERS_SIDS[0] = to_user_id;
		}else if(TEACHERS_SIDS[0] > 0 && to_user_id == TEACHERS_SIDS[0]) {

		}else{
			TEACHERS_SIDS[1] = to_user_id;
			rmt_vdo = VIDEO_STUDENT_2;
			rmt_box = VIDEO_BOX_STUDENT_2;
		}
	}

	$(rmt_box).find(".nickname").text('User '+to_user_id);

	//vdo
	var options = {
		localVideo : VIDEO_SELF,
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

	var rmt_box = VIDEO_BOX_STUDENT_1;
	var rmt_vdo = VIDEO_STUDENT_1;

	if (USER_TYPE == 1) {
		if (user_type == 2) {
			rmt_vdo = VIDEO_TEACHER;
			rmt_box = VIDEO_BOX_TEACHER;
		}
	}else{
		if (TEACHERS_SIDS[0] == 0) {
			TEACHERS_SIDS[0] = from_user_id;
		}else if (TEACHERS_SIDS[0] > 0 && from_user_id == TEACHERS_SIDS[0]) {

		}else{
			TEACHERS_SIDS[1] = from_user_id;
			rmt_vdo = VIDEO_STUDENT_2;
			rmt_box = VIDEO_BOX_STUDENT_2;
		}
	}

	$(rmt_box).find(".nickname").text('User '+from_user_id);

	//vdo
	var options = {
		localVideo : VIDEO_SELF,
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
	canvas.width = VIDEO_SELF.videoWidth;
  	canvas.height = VIDEO_SELF.videoHeight;
  	canvas.getContext('2d').drawImage(VIDEO_SELF, 0, 0, canvas.width, canvas.height);
}