[![NPM version](https://badge.fury.io/js/nodecastor.png)](http://badge.fury.io/js/nodecastor)

This library is an experiment to provide a sender API for Google
Chromecast devices using mDNS and some TLS protobuf protocol instead
of the DIAL discovery protocol. Google
[recently switched away from DIAL][1]. While SSDP/DIAL support is
still present, existing applications have to migrate to the new SDK
using the new protocol.

This library doesn't support the DIAL discovery protocol. See
[nodecast][] instead.

[1]: https://plus.google.com/+SebastianMauer/posts/83hTniKEDwN
[nodecast]: https://github.com/wearefractal/nodecast

# Install

Install the library with `npm install nodecastor`.

# Usage

This is still a work in progress. The API is not stable, the quality
is pretty low and there are a lot of bugs.

## Library

To use the library, you first need to discover what Chromecast devices
are available on the network. This is an optional step as you can also
declare a Chromecast manually from its IP address.

```javascript
var nodecastor = require('nodecastor');
nodecastor.scan()
  .on('online', function(d) {
    console.log('New device', util.inspect(d));
  })
  .on('offline', function(d) {
    console.log('Removed device', util.inspect(d));
  });
```


On Linux, if no device is discovered, first check that your machine is
able to do mDNS address resolution. The library used for this purpose
delegates this to the libc. You should have something like that in
`/etc/nsswitch.conf`:

    hosts: files mdns4_minimal [NOTFOUND=return] dns mdns4

Both `online` and `offline` events will invoke the callback with a
`CastDevice` instance. You can also create the `CastDevice` instance
manually:

```javascript
nodecastor.CastDevice({
      friendlyName: 'My secret Chromecast',
      address: '192.168.1.27',
      port: 8009
});
```

Once you have a `CastDevice` instance, you can request some
informations about it:

```javascript
d.status(function(err, s) {
  if (!err) {
    console.log('Chromecast status', util.inspect(s));
  }
});
```

You can also request an application. This will give you a
`CastApplication` instance.

```javascript
d.application('YouTube', function(err, a) {
  if (!err) {
    console.log('YouTube application', util.inspect(a));
  }
});
```

Once you have a `CastApplication` instance, you can request a
`CastSession` instance for this application. For that, you can either
join an existing application (which should already be running) or you
can run a new instance.

```javascript
a.run('urn:x-cast:com.google.cast.demo.tictactoe', function(err, s) {
  if (!err) {
    console.log('Got a session', util.inspect(s));
  }
});
a.join('urn:x-cast:com.google.cast.demo.tictactoe', function(err, s) {
  if (!err) {
    console.log('Joined a session', util.inspect(s));
  }
});
```

The first parameter is the namespace you expect to run or join. Any
messages sent on this session will use the given namespace.

You can then send messages and receive answers (not all messages have
to be answered):

```javascript
s.send({ data: 'hello' }, function(err, data) {
  if (!err) {
    console.log('Got an answer!', util.inspect(data));
  }
});
s.on('message', function(data) {
  console.log('Got an unexpected message', util.inspect(data));
});
```

Don't use callbacks for messages that you don't expect answers
for. They will just leak memory...

A `CastSession` object can emit a `close` event when the connection is
closed. A `CastDevice` object can emit a `disconnect` event when the
connection with the device is lost and a `connect` event when the
connection has been established (but there is no need to wait for such
an event). You can stop a session with `.stop()` or close connection
to a device with `.stop()`.

Any object can take as an option a logger. For example:

```javascript
var c = new CastDevice({
  address: '192.168.1.27',
  logger: console
});
```

## Command-line helper

The functionality of this library can be tested with the `chromecast`
helper. Invoke it with `chromecast -h` to get help. It embeds some
simple examples too.

The Tic Tac Toe application is quite incomplete. It is expected to
play against a human player. Here is how to use it:

 1. Download the [Chrome version from GitHub](https://github.com/googlecast/Cast-TicTacToe-chrome)
 2. Direct a browser to it (`python -mSimpleHTTPServer` if you want a quick way to get a webserver to serve the files)
 3. Start casting the application from Chrome.
 4. Starts `chromecast tictactoe 192.168.1.24`.
 5. On Chrome, click play.

# Protocol description

There is no formal description of the protocol. However, you can look
at `channel.js` which shows how to build low-level messages, layer by
layer. The lower-level protocol is implemented directly in Chrome and
the protocol is described in `cast_channel.proto`.

The high-level protocol, used by the Chromecast extension, can be
discovered by modifying the extension. The following code can be
appended to `background_script.js`:

```javascript
chromesendAndLog = function(channel, data) {
  console.log('[TAP CHROMECAST send]', data);
  return chrome.cast.channel.send.apply(chrome.cast.channel, arguments);
};
chrome.cast.channel.onMessage.addListener(function(channel, data) {
  console.log('[TAP CHROMECAST recv]', data);
});
```

Any occurrence of `chrome.cast.channel.send` needs to be replaced by
`chromesendAndLog`. Monkey-patching seems to be ineffective because
the whole `chrome.cast.channel` seems to be erased everytime you
connect/disconnect to a Chromecast. Then, filter the log messages with
`TAP CHROMECAST` in Chrome developper tools (click on
`background.html` for the Chromecast extension in
`chrome://extensions`).
