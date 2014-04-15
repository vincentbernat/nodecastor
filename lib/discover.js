'use strict';

var util = require('util'),
    mdns = require('mdns2'),
    events = require('events'),
    Chromecast = require('./chromecast');

function Discoverer() {
  var self = this;
  events.EventEmitter.call(this);
  this.browser = mdns.createBrowser(mdns.tcp('googlecast'));
  this.browser.on('serviceUp', on_service_up);
  this.devices = [];

  function on_service_up(device) {
    if (!device.addresses ||
        device.addresses.length === 0 ||
        !device.name ||
        !device.port ||
        !device.txtRecord ||
        !device.txtRecord.fn ||
        !device.txtRecord.id) {
      return;
    }
    // Usually, Chromecast device are using IPv4 only.
    var c = new Chromecast({
      name: device.txtRecord.fn,
      address: device.addresses[0],
      port: device.port,
      id: device.txtRecord.id
    });
    self.devices[c.id] = c;
    self.emit('connected', c);
  }
  function on_service_down(device) {
    var id = (device.txtRecord || {}).id;
    if (!self.devices[id]) {
      return;
    }
    self.emit('disconnected', self.devices[id]);
    delete self.devices[id];
  }
}
util.inherits(Discoverer, events.EventEmitter);

Discoverer.prototype.start = function() {
  this.browser.start();
  return this;
};
Discoverer.prototype.end = function() {
  this.browser.end();
  return this;
};

module.exports = Discoverer;
