const net = require('net');
const tls = require('tls');
const filters = require('../filters.js');
const TelnetDevice = require('./telnet.js');
const Logger = require('../logger.js');

class Server extends TelnetDevice {
 create(options) {
  this.host = options.host;
  this.port = options.port;
  this.tls = options.tls;
  this.connectionAttempts = 0;
  this.autoReconnect = options.autoReconnect !== undefined ? options.autoReconnect : true;
  this.autoReconnectInterval = options.autoReconnectInterval || 3000;
  this.connectTimeout = options.connectTimeout || 7000;
  this.disconnectedSince = this.startdate;
  if (options.link) {
   if (options.link.type === 'client' && !this.logger) {
    if (options.link.logger) this.logger = options.link.logger;
    else {
     const loggerID = `on port ${options.link.socket.address().port}`;
     this.logger = this.proxy.loggers[loggerID] || (new Logger({ ...options, loggerID }));
    }
   }
   const wait = options.initialLinkingDelay !== undefined ? options.initialLinkingDelay : 200; // Give VIP Mud enough time to load triggers before data starts pouring in.
   if (wait > 0) this.timers.set('initialLinkingDelay', () => this.proxy.link(options.link, this), wait);
   else this.proxy.link(options.link, this);
  }
  this.events.on('connect', () => this.socket.setTimeout(0));
  super.create(options);
  this.connect();
 }
 close(reconnect) {
  if (this.closed) return;
  if (reconnect && this.autoReconnect && (!this.connectionEnded || (this.lastLines.length > 1 && this.lastLines[this.lastLines.length - 2].startsWith('*** Server shutdown by ')))) {
   if (this.connectionAttempts === 0) {
    if ((this.disconnectedSince - this.connectedSince) > 2500) this.forward(`*** Auto reconnect in progress... ***`);
   }
   else if (this.connectionAttempts === 1 && !this.connectedSince) this.forward(`*** Connection to ${this.host} on port ${this.port} failed. Auto reconnect in progress... ***`);
   this.timers.set('reconnect', () => this.connect(), this.autoReconnectInterval - ((new Date()) - this.lastConnectionAttempt));
  }
  else super.close();
 }
 connect() {
  this.connectionEnded = false;
  this.connectionAttempts++;
  this.lastConnectionAttempt = new Date();
  const connectionArgs = [
   { host: this.host, port: this.port },
   () => {
    const { address, port } = this.socket.address();
    this.proxy.console(`${this.title} established ${this.socket.authorized === true ? 'secure ' : ''}connection with ${address} using port ${port}`);
    if (this.socket.authorized === false) this.proxy.console(`TLS authorization error:`, this.socket.authorizationError);
    this.events.emit('connect');
   },
  ];
  this.proxy.console(`${this.title} connecting to ${this.host} on port ${this.port}`);
  this.socket = this.tls ? tls.connect(...connectionArgs) : net.createConnection(...connectionArgs);
  if (!this.link) this.socket.pause();
  if (this.connectTimeout) {
   this.socket.setTimeout(this.connectTimeout);
   this.socket.once('timeout', () => {
    this.proxy.console(`${this.title} connection timeout`);
    this.socket.destroy();
   });
  }
  this.applySocketOptions();
 }
 input(chunk) {
  if (!chunk.passThrough) chunk.data = filters.decode(chunk.data);
  super.input(chunk);
 }
 output(chunk) {
  if (!chunk.passThrough) chunk.data = filters.encode(chunk.data);
  super.output(chunk);
 }
} 

module.exports = Server;
