/* jshint camelcase:false */

'use strict';

var fs = require('fs');
var path = require('path');
var util = require('util');
var childProcess = require('child_process');
var events = require('events');
var wineProxy = require('./wine-proxy');
var async = require('async');
var net = require('net');
var temp = require('temp');
var extend = require('xtend');
var rimraf = require('rimraf');

var isWindows = (process.platform === 'win32');
var RconConnection, Tail;

if (!isWindows) {
  RconConnection = require('samp-rcon');
  Tail = require('tailnative');
}

var useLinuxBinary = (!isWindows && process.platform !== 'darwin');
var activeServers = [];
var reSplitSpace = /\s+/;
var reIsWindowsBinary = /\.exe$/i;
var reCfgLine = /^\s*([a-z0-9_]+)(?:\s+(.+?))?\s*$/i;
var cfgArrayKeys = ['plugins', 'filterscripts'];
var cfgNumberKeys = [
  'lanmode', 'maxplayers', 'port', 'announce', 'query', 'chatlogging',
  'onfoot_rate', 'incar_rate', 'weapon_rate', 'stream_distance',
  'stream_rate', 'maxnpc'
];

function closeAll(signal, sync) {
  if (signal === undefined) {
    signal = 'SIGTERM';
  }

  var server;

  while ((server = activeServers.pop())) {
    server.stop(signal, sync);
  }
}

function closeAllSync(signal) {
  closeAll(signal, true);
}

function tempServer(amx, opts, fn) {
  if (typeof opts !== 'object' || !opts.binary) {
    throw new Error('Server binary not specified');
  }

  if (opts.plugins && !util.isArray(opts.plugins)) {
    throw new TypeError('"plugins" should be an array');
  }

  var cfg = getDefaultCfg();
  var operations = {
    tempDir: temp.mkdir.bind(null, 'samp-')
  };

  cfg.query = 0;
  cfg.announce = 0;
  cfg.rcon_password = null;
  cfg.port = null;
  cfg.gamemodes = [{
    name: '../gm',
    repeat: 1
  }];

  var amxData = null;

  if (amx instanceof Buffer) {
    amxData = amx;
  } else {
    operations.amxRead = fs.readFile.bind(null, amx);
  }

  for (var key in opts) {
    if (cfg.hasOwnProperty(key)) {
      cfg[key] = opts[key];
    }
  }

  if (!cfg.rcon_password) {
    cfg.rcon_password = Math.random().toString(36).substring(2, 12);
  }

  if (cfg.port === null) {
    operations.freePort = getFreePort;
  }

  async.series(operations, function(err, results) {
    if (err) return fn(err);

    if (results.freePort) {
      cfg.port = results.freePort;
    }

    if (results.amxRead) {
      amxData = results.amxRead;
    }

    fs.writeFile(
      path.join(results.tempDir, 'gm.amx'),
      amxData,
      function(err) {
        if (err) return fn(err);

        fs.writeFile(
          path.join(results.tempDir, 'server.cfg'),
          buildCfg(cfg, results.tempDir),
          function(err) {
            if (err) return fn(err);

            var server = new Server({
              binary: opts.binary,
              cwd: results.tempDir,
              temporary: true
            });

            fn(null, server);
          }
        );
      }
    );
  });
}

function getFreePort(fn) {
  var server = net.createServer();
  var calledFn = false;

  server.on('error', function(err) {
    server.close();

    if (!calledFn) {
      calledFn = true;
      fn(err);
    }
  });

  server.listen(0, function() {
    var port = server.address().port;

    server.close();

    if (!calledFn) {
      calledFn = true;

      if (!port) {
        fn(new Error('Unable to get the server\'s given port'));
      } else {
        fn(null, port);
      }
    }
  });
}

function getDefaultCfg() {
  return {
    lanmode: 0,
    rcon_password: 'changeme',
    maxplayers: 50,
    port: 7777,
    hostname: 'SA-MP 0.3 Server',
    gamemodes: [],
    filterscripts: [],
    announce: 0,
    query: 1,
    chatlogging: 0,
    weburl: 'www.sa-mp.com',
    onfoot_rate: 40,
    incar_rate: 40,
    weapon_rate: 40,
    stream_distance: 300.0,
    stream_rate: 1000,
    maxnpc: 0,
    logtimeformat: '[%H:%M:%S]',
    bind: '0.0.0.0',
    plugins: []
  };
}

function buildCfg(cfg, dir) {
  var output = '';
  var gamemodes = path.resolve(dir, 'gamemodes');
  var filterscripts = path.resolve(dir, 'filterscripts');
  var plugins = path.resolve(dir, 'plugins');

  function relativePath(d, p) {
    p = path.resolve(d, p);

    return path.relative(d, p);
  }

  function putGamemode(gm) {
    output += 'gamemode' + idx + ' ';
    idx += 1;

    if (typeof gm === 'string') {
      output += relativePath(gamemodes, gm) + ' 1';
    } else {
      output += relativePath(gamemodes, gm.name) + ' ' + gm.repeat;
    }

    output += '\n';
  }

  for (var key in cfg) {
    if (!cfg.hasOwnProperty(key)) {
      continue;
    }

    if (key === 'plugins') {
      output += 'plugins ';
      output += cfg[key].map(relativePath.bind(null, plugins)).join(' ');
      output += '\n';
    } else if (key === 'filterscripts') {
      output += 'filterscripts ';
      output += cfg[key].map(relativePath.bind(null, filterscripts)).join(' ');
      output += '\n';
    } else if (key === 'gamemodes') {
      var idx = 0;

      cfg[key].forEach(putGamemode);
    } else {
      output += key + ' ' + cfg[key] + '\n';
    }
  }

  return output;
}

var Server = function SampServer(opts) {
  events.EventEmitter.call(this);

  if (typeof opts !== 'object' || !opts.binary) {
    throw new Error('Server binary not specified');
  }

  this.binary = path.resolve(opts.binary);
  this.started = false;
  this.starting = false;
  this.cfg = null;
  this.rconConnection = null;
  this.commandQueue = [];
  this.temporary = opts.temporary || false;

  if (!useLinuxBinary || reIsWindowsBinary.test(this.binary)) {
    this.windowsBinary = true;
  } else {
    this.windowsBinary = false;
  }

  if (opts.cwd) {
    this.cwd = path.resolve(opts.cwd);
  } else {
    this.cwd = path.dirname(this.binary);
  }
};

util.inherits(Server, events.EventEmitter);

Server.prototype.start = function() {
  var self = this;

  if (this.child || this.starting) {
    this.stop('SIGKILL');
  }

  this.started = false;
  this.starting = true;

  activeServers.push(this);

  var operations = [this.readCfg.bind(this)];

  if (!isWindows) {
    operations.push(this.touchLog.bind(this),
                    this.tailLog.bind(this));
  }

  if (this.windowsBinary && !wineProxy.isInitialized) {
    operations.unshift(wineProxy.init);
  }

  async.series(operations, function(err) {
    if (err) {
      self.starting = false;
      self.stop('SIGKILL');
      self.emit('error', err);

      return;
    }

    var opts = {
      cwd: self.cwd,
      stdio: isWindows ? 'pipe' : 'ignore',
      env: {
        DISPLAY: ''
      }
    };

    if (self.windowsBinary) {
      self.child = wineProxy.spawn(self.binary, [], opts);
    } else {
      self.child = childProcess.spawn(self.binary, [], opts);
    }

    self.child
      .on('error', self.emit.bind(self, 'error'))
      .on('exit', function(code, signal) {
        if (self.starting) {
          self.stop('SIGKILL');
          self.emit('error', new Error(
            'The server process encountered an error; ' +
            'exit code: ' + code + ', signal: ' + signal,
            'NOSTART'
          ));
        } else if (self.started) {
          self.stop();
        }
      });

    if (isWindows) {
      self.child.stdout.on('data', function(data) {
        self.emit('output', data.toString());
      });
    } else {
      if (self.rconConnection) {
        self.rconConnection.close();
      }

      self.rconConnection = new RconConnection(
        self.cfg.bind,
        self.cfg.port,
        self.cfg.rcon_password,
        '0.0.0.0'
      );

      self.rconConnection
        .on('error', self.emit.bind(self, 'error'))
        .on('ready', self.flushCommandQueue.bind(self));
    }

    self.on('output', function(data) {
      if (data.indexOf('Unable to start server on') !== -1) {
        self.stop('SIGKILL');
        self.emit('error', new Error(
          'Unable to start the server. Invalid bind IP or port in use?'
        ));
      }
    });

    self.starting = false;
    self.started = true;
  });

  return this;
};

Server.prototype.touchLog = function(fn) {
  var self = this;
  var file = path.join(this.cwd, 'server_log.txt');

  fs.stat(file, function(err, stats) {
    var flags = 'r';

    if (err) {
      if (err.code === 'ENOENT') {
        flags = 'a+';
      } else {
        return fn.call(self, err);
      }
    }

    fs.open(file, flags, function(err, fd) {
      if (err) return fn.call(self, err);

      fs.close(fd, fn.bind(self));
    });
  });

  return this;
};

Server.prototype.stop = function(signal, sync) {
  if (this.stopping) {
    return;
  }

  var operations = [];
  var self = this;

  this.stopping = !sync;
  this.starting = false;
  this.started = false;

  if (this.logTail) {
    this.logTail.close();

    this.logTail = null;
  }

  if (this.child) {
    this.child.kill(signal);
    this.child = null;
  }

  if (this.temporary) {
    if (sync) {
      try {
        rimraf.sync(this.cwd);
      } catch (e) {}
    } else {
      operations.push(rimraf.bind(null, this.cwd));
    }
  }

  if (sync) {
    this.emit('stop');
  } else {
    async.series(operations, function() {
      self.stopping = false;

      self.emit('stop');
    });
  }

  return this;
};

Server.prototype.stopSync = function(signal) {
  this.stop(signal, true);
};

Server.prototype.tailLog = function(fn) {
  if (this.logTail) {
    this.logTail.close();
  }

  this.logTail = new Tail(path.join(this.cwd, 'server_log.txt'));

  this.logTail
    .on('data', this.emit.bind(this, 'output'))
    .on('error', this.emit.bind(this, 'error'))
    .on('end', function() {
      if (this.starting || this.started) {
        this.stop('SIGKILL');
        this.emit('error', new Error('Log tail ended unexpectedly'));
      }
    }.bind(this));

  fn();

  return this;
};

Server.prototype.readCfg = function(fn) {
  var self = this;
  var file = path.join(this.cwd, 'server.cfg');

  this.cfg = null;

  fs.readFile(file, function(err, data) {
    if (err) return fn.call(self, err);

    data = data.toString().split('\n');

    // Start off with the defaults, as that's how the server behaves
    var cfg = getDefaultCfg();

    for (var i = 0, len = data.length; i < len; i++) {
      var match = data[i].match(reCfgLine);

      if (match) {
        var key = match[1].toLowerCase();

        if (key === 'echo') {
          continue;
        }

        var value = match[2] ? match[2].toLowerCase() : null;

        if (key.indexOf('gamemode') === 0) {
          var n = +key.substr(8);

          value = value.split(reSplitSpace);

          cfg.gamemodes[n] = {
            name: path.resolve(self.cwd, 'gamemodes', value[0]),
            repeat: +value[1] || 1
          };

          continue;
        }

        if (cfgArrayKeys.indexOf(key) !== -1) {
          if (value) {
            value = value.split(reSplitSpace);
          } else {
            value = [];
          }
        } else if (value && cfgNumberKeys.indexOf(key) !== -1) {
          value = +value;
        }

        cfg[key] = value;
      }
    }

    // Resolve filterscript paths
    cfg.filterscripts.forEach(function(val, i, arr) {
      arr[i] = path.resolve(self.cwd, 'filterscripts', val);
    });

    // Resolve plugin paths
    cfg.plugins.forEach(function(val, i, arr) {
      arr[i] = path.resolve(self.cwd, 'plugins', val);
    });

    // Clean the gamemodes array from sparse slots
    cfg.gamemodes = cfg.gamemodes.filter(function(val) {
      return val;
    });

    self.cfg = cfg;

    fn.call(self);
  });

  return this;
};

Server.prototype.send = function(command) {
  if (isWindows) {
    if (this.child) {
      this.child.stdin.write(command);
    } else {
      this.commandQueue.push(command);
    }
  } else {
    if (this.rconConnection && this.rconConnection.ready) {
      this.rconConnection.send(command);
    } else {
      this.commandQueue.push(command);
    }
  }

  return this;
};

Server.prototype.flushCommandQueue = function() {
  var command;

  while ((command = this.commandQueue.pop())) {
    this.send(command);
  }
};

module.exports = {
  Server: Server,
  closeAll: closeAll,
  tempServer: tempServer,
  buildCfg: buildCfg
};