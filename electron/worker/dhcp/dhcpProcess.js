const WorkerMessageHandler = require('../core/workerMessageHandler');
const DhcpWorker = require('./dhcpWorker');
const Dhcp6Worker = require('./dhcp6Worker');

const messageHandler = new WorkerMessageHandler();

new DhcpWorker({ messageHandler });
new Dhcp6Worker({ messageHandler });

messageHandler.init();
