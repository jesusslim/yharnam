# Engine

## dependency

	os:ubuntu 14.04
	npm
	bower
	node
	
## install

[guide](http://doc-kurento.readthedocs.io/en/stable/user/installation.html)

### install kurento server

	# KMS for Ubuntu 14.04 (Trusty)
		DISTRO="trusty"
		
	# KMS for Ubuntu 16.04 (Xenial)
		DISTRO="xenial"		
	
	sudo apt-key adv --keyserver keyserver.ubuntu.com --recv-keys 5AFA7A83
	sudo tee "/etc/apt/sources.list.d/kurento.list" >/dev/null <<EOF
	# Kurento Media Server - Release packages
	deb [arch=amd64] http://ubuntu.openvidu.io/6.7.1 $DISTRO kms6
	EOF
	
	sudo apt-get update
	sudo apt-get install kurento-media-server
	
	sudo service kurento-media-server start
	sudo service kurento-media-server stop
	
### install npm/bower/node
	
	curl -sL https://deb.nodesource.com/setup_4.x | sudo bash -
	sudo apt-get install -y nodejs
	sudo npm install -g bower
	
### run

copy project to server
	
	npm install

or

	npm install --unsafe-perm

if err about bower:

	cd static
	bower install --allow-root
		
if err about npm,update npm:
	
	sudo npm install npm@latest -g

after all:

	npm start
	
u will see:

	> Yharnam@1.0.0 start /home/Yharnam
	> node server.js

	server start at https://localhost:8443/
	
## domain

免费域名:freenom

免费dns解析:dnspod(腾讯云)

免费https证书:腾讯云
	
	