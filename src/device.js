const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');
const EventEmitter = require('events');
const Middleware = require('./middleware.js');
const utils = require('./utils.js');

class Device {
 constructor(options) {
  this.startdate = new Date();
  this.proxy = options.proxy;
  this.id = options.id || this.proxy.getNewID();
  this.proxy.devices[this.id] = this;
  this.proxy.devicesCount++;
  this.buffer = Buffer.from('');
  this.timers = {};
  this.events = new EventEmitter();
  this.connected = false;
  this.disconnectedSince = this.startdate;
  this.connectionAttempts = options.connectionAttempts;
  this.lastConnectionAttempt = options.lastConnectionAttempt;
  this.encoding = options.encoding || 'binary';
  this.lineLengthThreshold = 1024 * 1024 * 5;
  this.ignoreBlankLines = options.ignoreBlankLines || false;
  this.lastLines = [];
  this.maxLastLines = 10;
  this.eol = options.eol || "\r\n";
  this.eolTelnet = options.eolTelnet || Buffer.from([13, 10]);
  this.host = options.host;
  this.port = options.port;
  this.tls = options.tls;
  this.keepAlive = options.keepAlive !== undefined ? options.keepAlive : 3000;
  this.connectTimeout = options.connectTimeout || 7000;
  this.autoReconnect = options.autoReconnect !== undefined ? options.autoReconnect : Boolean(this.host && this.port && true);
  this.autoReconnectInterval = options.autoReconnectInterval || 3000;
  this.loggerID = options.loggerID;
  this.type = options.type || (('socket' in options) ? 'client' : 'server');
  this.observers = options.observers || [];
  this.workers = {};
  this.initialLinkingDelay = options.initialLinkingDelay || 200; // Give VIP Mud enough time to load triggers before data starts pouring in.
  this.token = options.token || crypto.randomBytes(4).toString('hex');
  this.encode = this.type === 'client';
  this.decode = this.type !== 'client';
  this.middleware = new Middleware({ device: this });

  if (options.link) {
   this.events.once('connect', () => {
    if (this.initialLinkingDelay && this.lastConnectionAttempt) {
     const wait = this.initialLinkingDelay - ((new Date()) - this.lastConnectionAttempt);
     if (wait > 0) {
      this.timers.initialLinkingDelay = setTimeout(() => {
       delete this.timers.initialLinkingDelay;
       this.proxy.link(options.link, this);
      }, wait);
      return;
     }
    }
    this.proxy.link(options.link, this);
   });
  }
  this.events.on('connect', () => {
   this.connected = true;
   this.connectedSince = new Date();
   this.socket.setTimeout(0);
   if (this.link) this.events.emit('ready');
  });
  this.events.on('link', () => this.connected && this.events.emit('ready'));
  if (this.type === 'client') {
   this.soundpack = {};
   this.events.once('ready', () => this.respond(`#$#proxiani session version ${this.proxy.version} | token ${this.token}`));
   this.events.on('ready', () => {
    if (this.socket.authorized === false) this.respond(`*** TLS authorization failed. Please see px console for more information. ***`);
   });
  }
  this.events.on('ready', () => this.socket.resume());
  this.events.on('line', line => {
   const result = this.middleware.process(this.decode ? decode(line.toString(this.encoding)) : line.toString(this.encoding));
   const data = result.data;
   if (this.proxy.user.config.developerMode) {
    const time = (new Date()) - data.time;
    if (time > 250) this.proxy.console(`Middleware for device ${this.id} took ${time}ms to execute:`, new Error(`Input(${data.input.length}): ${data.input}`));
   }
   data.respond.forEach(line => this.respond(line));
   data.forward.forEach(line => this.forward(line));
   if (data.input.length > 0 && this.lastLines.push(data.input) > this.maxLastLines) this.lastLines.shift();
   if (this.proxy.user.config.logging && !data.input.startsWith('#$#')) {
    if (this.loggerID) this.events.emit('log', data, this);
    else if (this.link && this.link.loggerID) this.link.events.emit('log', data, this);
   }
  });
  this.events.on('log', (data, device) => {
   if (this.logger === false) return;
   if (this === device) return;
   const d = new Date();
   const dirNames = [this.proxy.user.logDir, String(d.getFullYear()), String(d.getMonth() + 1)];
   const dir = path.join(this.proxy.user.dir, ...dirNames);
   const fileName = `${utils.englishOrdinalIndicator(d.getDate())}, ${this.loggerID}.txt`;
   const logFile = path.join(dir, fileName);
   if (this.logFile !== logFile || !this.logger) {
    if (this.logger) {
     this.logger.end();
     delete this.logger;
    }
    const logFileExists = fs.existsSync(logFile);
    if (!logFileExists && !fs.existsSync(dir)) {
     let dir = this.proxy.user.dir;
     for (let i=0; i<dirNames.length; i++) {
      dir = path.join(dir, dirNames[i]);
      try {
       if (!fs.existsSync(dir)) fs.mkdirSync(dir);
      }
      catch (error) {
       this.logger = false;
       this.proxy.console(`Failed to create log directory for device ${this.id}:`, error);
       return;
      }
     }
    }
    try {
     this.logger = fs.createWriteStream(logFile, { flags: 'a', autoClose: true });
     this.logFile = logFile;
     if (!logFileExists) this.logger.write(`\tLog of ${utils.formatDateWordly(d)}.\r\n`);
    }
    catch (error) {
     this.logger = false;
     this.proxy.console(`Failed to create log for device ${this.id}:`, error);
    }
   }
   const time = utils.formatTime(d);
   try {
    if (time !== this.lastLogTime) {
     this.logger.write(`${data.input}\t[${time}]\r\n`);
     this.lastLogTime = time;
    }
    else this.logger.write(`${data.input}\r\n`);
   }
   catch (error) {
    this.logger = false;
    this.proxy.console(`Failed to create log for device ${this.id}:`, error);
   }
  });
  this.setSocket(options.socket);
  this.proxy.events.emit(`${this.type}Created`, this);
 }
 close() {
  this.autoReconnect = false;
  if (this.isClosing) return;
  this.isClosing = true;
  if (this.socket) {
   if (this.connected) {
    this.timers.forceSocketDestruction = setTimeout(() => this.socket.destroy(), 300);
    this.socket.end();
   }
   else this.socket.destroy();
  }
 }
 setSocket(socket) {
  if (this.socket) this.socket.unref();
  this.connectionEnded = false;
  if (socket) {
   this.socket = socket;
   if (!this.socket.connecting && !this.socket.destroyed) this.events.emit('connect');
   this.socket.on('connect', () => this.events.emit('connect'));
   if (this.link) this.socket.resume();
  }
  else if (this.host && this.port) {
   this.connectionAttempts++;
   this.lastConnectionAttempt = new Date();
   if (this.tls) {
    this.proxy.console(`Device ${this.id} connecting securely to ${this.host} on port ${this.port}`);
    this.socket = tls.connect({
     host: this.host,
     port: this.port,
    }, () => {
     this.proxy.console(`Device ${this.id} established secure connection with ${this.host} on port ${this.port}`);
     this.events.emit('connect');
     if (!this.socket.authorized) this.proxy.console(`TLS Authorization Error:`, this.socket.authorizationError);
    });
   }
   else {
    this.proxy.console(`Device ${this.id} connecting to ${this.host} on port ${this.port}`);
    this.socket = net.createConnection({
     host: this.host,
     port: this.port,
    }, () => {
     this.proxy.console(`Device ${this.id} connected to ${this.host} on port ${this.port}`);
     this.events.emit('connect');
    });
   }
   this.socket.setTimeout(this.connectTimeout);
   if (!this.link) this.socket.pause();
  }
  else throw `Missing socket or host/port`;
  if (this.keepAlive) this.socket.setKeepAlive(true, this.keepAlive);
  else this.socket.setKeepAlive(false);
  this.socket.on('timeout', () => {
   this.proxy.console(`Device ${this.id} timed out`);
   if (this.connected) this.socket.end();
   else this.socket.destroy();
  });
  this.socket.on('error', error => {
   this.proxy.console(`Device ${this.id} socket error: ${error}`);
  });
  this.socket.on('end', () => this.connectionEnded = true);
  this.socket.on('close', () => {
   if (this.buffer.length > 0) {
    this.forward(this.buffer);
    this.buffer = Buffer.from('');
   }
   if (this.autoReconnect && (!this.connectionEnded || (this.lastLines.length > 1 && this.lastLines[this.lastLines.length - 2].startsWith('*** Server shutdown by ')))) {
    this.events.emit('autoReconnecting');
    const wait = Math.max(0, this.autoReconnectInterval - ((new Date()) - this.lastConnectionAttempt));
    if (this.connected) {
     this.connected = false;
     this.disconnectedSince = new Date();
     this.proxy.console(`Device ${this.id} disconnected, but will attempt to auto reconnect${wait > 0 ? ` in ${wait}ms...` : ''}`);
     if (this.type === 'server' && ((new Date()) - this.connectedSince) < 2500) {
      this.forward(`*** Auto reconnect in progress... ***`);
     }
    }
    else {
     this.proxy.console(`Device ${this.id} attempts to auto reconnect${wait > 0 ? ` in ${wait}ms...` : ''}`);
     if (this.type === 'server') {
      if (this.connectionAttempts === 1) this.forward(`*** Connection to ${this.host}:${this.port} failed. Auto reconnect in progress... ***`);
     }
    }
    if (wait > 0) {
     this.timers.autoReconnect = setTimeout(() => {
      delete this.timers.autoReconnect;
      this.setSocket();
     }, wait);
    }
    else {
     this.setSocket();
    }
   }
   else {
    this.isClosing = true;
    for (let handle in this.timers) clearTimeout(this.timers[handle]);
    delete this.timers;
    for (let name in this.workers) this.closeWorker(name);
    this.proxy.unlink(this);
    this.proxy.console(`Closed device ${this.id}`);
    this.events.emit('close');
    this.socket.unref();
    delete this.socket;
    delete this.middleware.device;
    delete this.middleware;
    if (this.logger) {
     try {
      this.logger.write("\r\n");
      this.logger.end();
     }
     catch (error) {}
     delete this.logger;
    }
    delete this.events;
    delete this.observers;
    delete this.proxy.devices[this.id];
    this.proxy.devicesCount--;
    if (this.proxy.devicesCount === 0) {
     this.proxy.user.save();
     if (this.proxy.socketsCount === 0) this.proxy.events.emit('close');
     else if (this.proxy.outdated) this.proxy.close(true);
    }
    delete this.proxy;
   }
  });
  this.socket.on('data', data => {
   let iac = data.indexOf(0xff);
   while (iac !== -1 && data.length >= (iac + 3)) {
    this.respond(Buffer.from([255, data[iac+1] === 253 ? 252 : 254, data[iac+2]], this.encoding), false);
    data = iac === 0 ? data.slice(iac + 3) : Buffer.concat([data.slice(0, iac), data.slice(iac + 3)]);
    iac = data.indexOf(0xff);
   }
   if (data.length === 0) {
    return;
   }
   let lineStart = 0;
   let lineEnd = 0;
   if (this.buffer.length > 0) {
    data = Buffer.concat([this.buffer, data]);
    lineEnd = data.indexOf(this.eolTelnet, Math.max(0, this.buffer.length - this.eolTelnet.length));
    if (lineEnd === -1 && data.length > this.lineLengthThreshold) {
     this.buffer = Buffer.from('');
     this.forward(data, false);
     return;
    }
   }
   else {
    lineEnd = data.indexOf(this.eolTelnet);
   }
   if (this.ignoreBlankLines) {
    while (lineStart === lineEnd) {
     lineStart += this.eolTelnet.length;
     lineEnd = data.indexOf(this.eolTelnet, lineStart);
    }
   }
   while (lineEnd !== -1) {
    this.events.emit('line', data.slice(lineStart, lineEnd));
    lineStart = lineEnd + this.eolTelnet.length;
    lineEnd = data.indexOf(this.eolTelnet, lineStart);
    if (this.ignoreBlankLines) {
     while (lineStart === lineEnd) {
      lineStart += this.eolTelnet.length;
      lineEnd = data.indexOf(this.eolTelnet, lineStart);
     }
    }
   }
   this.buffer = lineStart === 0 ? data : data.slice(lineStart);
  });
 }
 worker(name, args = [], options = {}) {
  this.closeWorker(name);
  const worker = childProcess.fork(path.join(__dirname, 'workers', `${name}.js`), args, options);
  this.workers[name] = worker;
  worker.on('message', message => message.error && worker.emit('error', message.error));
  worker.on('error', error => worker === this.workers[name] && this.closeWorker(name, error));
  worker.on('exit', code => worker === this.workers[name] && this.closeWorker(name, code && `Exit code ${code}`));
  return worker;
 }
 closeWorker(name, reason) {
  const worker = this.workers[name];
  if (!worker) return;
  delete this.workers[name];
  if (worker.connected) {
   worker.kill();
   worker.disconnect();
  }
  worker.unref();
  if (reason) this.proxy.console(`Device ${this.id} ${name} worker closed because:`, reason);
 }
 on(...args) {
  this.events.on(...args);
 }
 respond(data, addEoL = true) {
  if (typeof data !== 'string') data = Buffer.isBuffer(data) ? data.toString(this.encoding) : (data === undefined ? 'undefined' : JSON.stringify(data, null, 1));
  if (this.connected) this.socket.write(addEoL ? data + this.eol : data, this.encoding);
  if (this.observers.length > 0) {
   this.observers = this.observers.filter(observer => {
    if (!observer.proxy) return false;
    if (observer.connected) observer.respond(data, addEoL);
    return true;
   });
  }
 }
 forward(data, addEoL = true) {
  if (this.link && this.link.connected) {
   if (typeof data !== 'string') data = Buffer.isBuffer(data) ? data.toString(this.encoding) : (data === undefined ? 'undefined' : JSON.stringify(data, null, 1));
   if (addEoL) data += this.link.eol;
   this.link.socket.write(this.encode ? encode(data) : data, this.encoding);
  }
 }
} 

const encode = data => data.replace(/[\x7F-\xFE]/g, m => '%' + m.charCodeAt(0).toString(16));
const decode = data => data.replace(/%[0-9a-f]{2}/g, m => {
 const n = parseInt(m.slice(1), 16);
 return n < 127 || n === 255 ? m : String.fromCharCode(n);
});

module.exports = Device;
