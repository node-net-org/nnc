/**
 * Every command, in one registry.
 */

import { capabilitiesCommand, helloCommand } from './client.js';
import { abandonCommand, applyCommand, beginCommand, changesCommand, confirmCommand, revertCommand } from './transaction.js';
import { datastoresCommand, diffCommand, modulesCommand, namespacesCommand, readCommand, removeCommand, resolveCommand, valueCommand } from './content.js';
import { connectCommand, disconnectCommand, exitCommand, helpCommand, listenCommand, statusCommand, targetsCommand } from './common.js';
import { eofCommand, framingCommand, receivedCommand, sendCommand, sendFileCommand, sendHexCommand, serverHelloCommand, showCommand } from './low.js';
import { notificationsCommand } from './notifications.js';
import { deviceCommand, profileCommand, rpcCommand } from './operations.js';
import { Registry } from './registry.js';
import { historyCommand, outputCommand, showLastCommand } from './output.js';
import { setCommand } from './settings.js';
import { traceCommand } from './trace.js';

export function createRegistry(): Registry {
  return new Registry().add(
    connectCommand,
    listenCommand,
    disconnectCommand,
    statusCommand,
    targetsCommand,
    helpCommand,
    exitCommand,
    helloCommand,
    capabilitiesCommand,
    rpcCommand,
    deviceCommand,
    profileCommand,
    readCommand,
    valueCommand,
    removeCommand,
    resolveCommand,
    namespacesCommand,
    diffCommand,
    datastoresCommand,
    modulesCommand,
    beginCommand,
    changesCommand,
    abandonCommand,
    applyCommand,
    confirmCommand,
    revertCommand,
    notificationsCommand,
    traceCommand,
    setCommand,
    outputCommand,
    showLastCommand,
    historyCommand,
    serverHelloCommand,
    sendCommand,
    framingCommand,
    showCommand,
    sendHexCommand,
    sendFileCommand,
    receivedCommand,
    eofCommand,
  );
}
