/**
 * @license
 * Copyright 2016 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @fileoverview This file contains the Closure-style message channel (see
 * <http://google.github.io/closure-library/api/interface_goog_messaging_MessageChannel.html>)
 * wrapper around the Chrome long-lived message connections (see
 * <https://developer.chrome.com/extensions/messaging#connect>).
 */

goog.provide('GoogleSmartCard.PortMessageChannel');

goog.require('GoogleSmartCard.ContainerHelpers');
goog.require('GoogleSmartCard.DebugDump');
goog.require('GoogleSmartCard.Logging');
goog.require('GoogleSmartCard.MessageChannelPinging.PingResponder');
goog.require('GoogleSmartCard.MessageChannelPinging.Pinger');
goog.require('GoogleSmartCard.TypedMessage');
goog.require('goog.asserts');
goog.require('goog.log');
goog.require('goog.log.Logger');
goog.require('goog.messaging.AbstractChannel');
goog.require('goog.object');

goog.scope(function() {

const GSC = GoogleSmartCard;

const Pinger = GSC.MessageChannelPinging.Pinger;
const PingResponder = GSC.MessageChannelPinging.PingResponder;

/**
 * This class is a wrapper around the Chrome long-lived message connections (see
 * <https://developer.chrome.com/extensions/messaging#connect>) that transforms
 * them into Closure-style message channels (see
 * <http://google.github.io/closure-library/api/interface_goog_messaging_MessageChannel.html>).
 *
 * Apart from adapting the Port communication mechanisms into the methods of the
 * goog.messaging.AbstractChannel class, this class enables pinging over this
 * message channel (see the message-channel-pinging.js file for details).
 * @param {!Port} port
 * @param {function()=} opt_onEstablished
 * @constructor
 * @extends goog.messaging.AbstractChannel
 */
GSC.PortMessageChannel = function(port, opt_onEstablished) {
  PortMessageChannel.base(this, 'constructor');

  /**
   * @type {Port?}
   * @private
   */
  this.port_ = port;

  /** @type {string|null} @const */
  this.extensionId = this.getPortExtensionId_(port);

  /**
   * @type {!goog.log.Logger}
   * @const
   */
  this.logger = GSC.Logging.getScopedLogger(
      'PortMessageChannel<"' + port.name + '"' +
      (this.extensionId === null ? '' : ', id="' + this.extensionId + '"') +
      '>');

  /** @private */
  this.boundDisconnectEventHandler_ = this.disconnectEventHandler_.bind(this);
  this.port_.onDisconnect.addListener(this.boundDisconnectEventHandler_);

  /** @private */
  this.boundMessageEventHandler_ = this.messageEventHandler_.bind(this);
  this.port_.onMessage.addListener(this.boundMessageEventHandler_);

  this.registerDefaultService(this.defaultServiceCallback_.bind(this));

  /** @private */
  this.pingResponder_ = new PingResponder(this, this.logger);

  /** @private */
  this.pinger_ = new Pinger(this, this.logger, opt_onEstablished);

  goog.log.fine(this.logger, 'Initialized successfully');
};

const PortMessageChannel = GSC.PortMessageChannel;

goog.inherits(PortMessageChannel, goog.messaging.AbstractChannel);

/** @override */
PortMessageChannel.prototype.send = function(serviceName, payload) {
  GSC.Logging.checkWithLogger(this.logger, goog.isObject(payload));
  goog.asserts.assertObject(payload);

  const normalizedPayload =
      GSC.ContainerHelpers.substituteArrayBuffersRecursively(payload);

  const typedMessage = new GSC.TypedMessage(serviceName, normalizedPayload);
  const message = typedMessage.makeMessage();
  goog.log.log(
      this.logger, goog.log.Level.FINEST,
      'Posting a message: ' + GSC.DebugDump.debugDump(message));

  if (this.isDisposed()) {
    GSC.Logging.failWithLogger(
        this.logger, 'Failed to post message: the channel is already disposed');
  }

  /** @preserveTry */
  try {
    this.port_.postMessage(message);
  } catch (exc) {
    this.dispose();
    GSC.Logging.failWithLogger(this.logger, 'Failed to post message: ' + exc);
  }
};

/** @override */
PortMessageChannel.prototype.disposeInternal = function() {
  this.pinger_.dispose();
  this.pinger_ = null;

  this.pingResponder_.dispose();
  this.pingResponder_ = null;

  this.port_.onMessage.removeListener(this.boundMessageEventHandler_);
  this.boundMessageEventHandler_ = null;

  this.port_.onDisconnect.removeListener(this.boundDisconnectEventHandler_);
  this.boundDisconnectEventHandler_ = null;

  this.port_.disconnect();
  this.port_ = null;

  goog.log.fine(this.logger, 'Disposed');

  PortMessageChannel.base(this, 'disposeInternal');
};

/**
 * @param {!Port} port
 * @return {string|null}
 * @private
 */
PortMessageChannel.prototype.getPortExtensionId_ = function(port) {
  if (!goog.object.containsKey(port, 'sender'))
    return null;
  const sender = port['sender'];
  if (sender === undefined)
    return null;
  GSC.Logging.checkWithLogger(this.logger, goog.isObject(sender));
  if (!goog.object.containsKey(sender, 'id'))
    return null;
  const senderId = sender['id'];
  if (senderId === undefined)
    return null;
  GSC.Logging.checkWithLogger(this.logger, typeof senderId === 'string');
  return senderId;
};

/** @private */
PortMessageChannel.prototype.disconnectEventHandler_ = function() {
  let reason = '';
  if (chrome.runtime && chrome.runtime.lastError &&
      chrome.runtime.lastError.message) {
    reason = ` due to '${chrome.runtime.lastError.message}'`;
  }
  goog.log.info(
      this.logger, `Message port was disconnected${reason}, disposing...`);
  this.dispose();
};

/**
 * @param {*} message
 * @private
 */
PortMessageChannel.prototype.messageEventHandler_ = function(message) {
  goog.log.log(
      this.logger, goog.log.Level.FINEST,
      'Received a message: ' + GSC.DebugDump.debugDump(message));

  const typedMessage = GSC.TypedMessage.parseTypedMessage(message);
  if (!typedMessage) {
    GSC.Logging.failWithLogger(
        this.logger,
        'Failed to parse the received message: ' +
            GSC.DebugDump.debugDump(message));
  }

  this.deliver(typedMessage.type, typedMessage.data);
};

/**
 * @param {string} serviceName
 * @param {!Object|string} payload
 * @private
 */
PortMessageChannel.prototype.defaultServiceCallback_ = function(
    serviceName, payload) {
  GSC.Logging.failWithLogger(
      this.logger,
      'Unhandled message received: serviceName="' + serviceName +
          '", payload=' + GSC.DebugDump.debugDump(payload));
};
});  // goog.scope
