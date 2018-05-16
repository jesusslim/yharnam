var config = {
	//单房间用户数
	max_user_count:5,

	//inboundrtp丢失检测间隔
	missing_inboundrtp_check_intval:5,
	//inboundrtp丢失多少次进行重连
	missing_inboundrtp_times:2,

	//是否检测latency
	latency:true,
};
module.exports = config;