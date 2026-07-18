import { PrismaClient } from '@prisma/client';
import vm from 'node:vm';

const prisma = new PrismaClient();

function safeExecuteScript(code, sandbox, timeout) {
    timeout = timeout || 1000;
    const ctx = vm.createContext(sandbox);
    const script = new vm.Script('(function(){ ' + code + ' })()', { filename: 'user-script.js' });
    return script.runInContext(ctx, { timeout: timeout });
}

async function loadChain(chainId) {
    const chain = await prisma.ruleChain.findUnique({
        where: { id: chainId },
        include: { nodes: true, connections: true },
    });
    if (!chain || !chain.isActive) return null;
    const nodes = new Map();
    for (const node of chain.nodes) {
        nodes.set(node.id, { id: node.id, type: node.type, name: node.name, config: node.configuration || {}, debugEnabled: node.debugEnabled });
    }
    const connections = new Map();
    for (const conn of chain.connections) {
        const existing = connections.get(conn.fromNodeId) || [];
        existing.push({ toNodeId: conn.toNodeId, label: conn.label });
        connections.set(conn.fromNodeId, existing);
    }
    return { chainId: chainId, firstNodeId: chain.firstRuleNodeId, nodes: nodes, connections: connections };
}

const nodeImpls = {
    'input': { execute: async function(msg) { return { message: msg, output: 'Success' }; } },
    'msg-type-filter': {
        execute: async function(msg, config, ctx) {
            var types = config.messageTypes || [];
            var msgType = msg._messageType || (ctx.metadata && ctx.metadata.msgType) || '';
            var match = types.some(function(t) { return t === msgType; });
            return { message: msg, output: match ? 'True' : 'False' };
        },
    },
    'msg-type-switch': {
        execute: async function(msg, config, ctx) {
            var msgType = msg._messageType || (ctx.metadata && ctx.metadata.msgType) || 'Other';
            return { message: msg, output: msgType };
        },
    },
    'script-filter': {
        execute: async function(msg, config, ctx) {
            var sandbox = { msg: msg, metadata: ctx.metadata || {} };
            var result = safeExecuteScript(config.script, sandbox);
            return { message: msg, output: result ? 'True' : 'False' };
        },
    },
    'create-alarm': {
        execute: async function(msg, config, ctx) {
            var alarm = { type: config.alarmType, severity: config.severity, entityId: ctx.entityId, entityName: ctx.entityName, details: { message: msg } };
            return { message: msg, output: 'Success', alarms: [alarm] };
        },
    },
    'clear-alarm': {
        execute: async function(msg, config, ctx) {
            var out = Object.assign({}, msg);
            out._clearedAlarm = config.alarmType;
            return { message: out, output: 'Success' };
        },
    },
    'send-notification': {
        execute: async function(msg, config) {
            return { message: msg, output: 'Success', notifications: [{ title: config.title, targetRole: config.targetRole }] };
        },
    },
    'log': {
        execute: async function(msg) { return { message: msg, output: 'Success' }; },
    },
    'rule-chain-input': {
        execute: async function(msg, config) {
            var out = Object.assign({}, msg);
            out._delegateChain = config.targetChainId;
            return { message: out, output: 'Success' };
        },
    },
    'transform-script': {
        execute: async function(msg, config, ctx) {
            var sandbox = { msg: Object.assign({}, msg), metadata: Object.assign({}, ctx.metadata || {}) };
            safeExecuteScript(config.script, sandbox);
            return { message: sandbox.msg, output: 'Success', metadata: sandbox.metadata };
        },
    },
    'save-timeseries': { execute: async function(msg) { return { message: msg, output: 'Success' }; } },
    'save-attributes': { execute: async function(msg) { return { message: msg, output: 'Success' }; } },
    'originator-type-filter': {
        execute: async function(msg, config, ctx) {
            var names = config.templateNames || [];
            var match = names.length === 0 || names.includes(ctx.templateId);
            return { message: msg, output: match ? 'True' : 'False' };
        },
    },
};

async function executeChain(message, metadata, chainId, entityCtx, depth) {
    depth = depth || 0;
    var startTime = Date.now();
    var alarms = [], notifications = [], errors = [];
    var nodesExecuted = 0;
    var currentMsg = Object.assign({}, message);
    var currentMeta = Object.assign({}, metadata);

    if (depth >= 10) {
        return { success: false, errors: ['ERR_MAX_CHAIN_DEPTH'], nodesExecuted: 0, durationMs: 0, alarms: [], notifications: [], message: currentMsg, metadata: currentMeta, nodeTrace: [] };
    }

    var chain = await loadChain(chainId);
    if (!chain || !chain.firstNodeId) {
        return { success: true, message: currentMsg, metadata: currentMeta, alarms: alarms, notifications: notifications, errors: errors, nodesExecuted: 0, durationMs: Date.now() - startTime, nodeTrace: [] };
    }

    var ctx = { entityId: entityCtx.entityId, entityName: entityCtx.entityName, templateId: entityCtx.templateId, unsPath: entityCtx.unsPath, metadata: currentMeta, chainDepth: depth, debugEnabled: false };
    var visited = new Set();
    var queue = [{ nodeId: chain.firstNodeId, msg: currentMsg }];
    var nodeTrace = [];

    while (queue.length > 0) {
        var item = queue.shift();
        var nodeId = item.nodeId;
        var msg = item.msg;
        var visitKey = nodeId + '-' + nodesExecuted;
        if (visited.has(visitKey) && nodesExecuted > 100) { errors.push('ERR_LOOP_DETECTED'); break; }
        visited.add(visitKey);

        var nodeDef = chain.nodes.get(nodeId);
        if (!nodeDef) { errors.push('ERR_NODE_NOT_FOUND: ' + nodeId); continue; }

        var nodeImpl = nodeImpls[nodeDef.type];
        if (!nodeImpl) { errors.push('ERR_NODE_TYPE_UNKNOWN: ' + nodeDef.type); continue; }

        try {
            var result = await nodeImpl.execute(msg, nodeDef.config, ctx);
            nodesExecuted++;
            nodeTrace.push({ node: nodeDef.name, type: nodeDef.type, output: result.output });
            currentMsg = result.message;
            if (result.metadata) { currentMeta = Object.assign({}, currentMeta, result.metadata); ctx.metadata = currentMeta; }
            if (result.alarms) { for (var a of result.alarms) alarms.push(a); }
            if (result.notifications) { for (var n of result.notifications) notifications.push(n); }

            if (currentMsg._delegateChain) {
                var targetId = currentMsg._delegateChain;
                delete currentMsg._delegateChain;
                delete currentMsg._chainDepth;
                var sub = await executeChain(currentMsg, currentMeta, targetId, entityCtx, depth + 1);
                currentMsg = sub.message;
                currentMeta = Object.assign({}, currentMeta, sub.metadata);
                for (var sa of sub.alarms) alarms.push(sa);
                for (var sn of sub.notifications) notifications.push(sn);
                for (var se of sub.errors) errors.push(se);
                nodesExecuted += sub.nodesExecuted;
                if (sub.nodeTrace) nodeTrace.push({ delegatedTo: targetId, subTrace: sub.nodeTrace });
            }

            var outConns = (chain.connections.get(nodeId) || []).filter(function(c) { return c.label === result.output; });
            for (var conn of outConns) { queue.push({ nodeId: conn.toNodeId, msg: currentMsg }); }
        } catch (err) {
            nodesExecuted++;
            var errorMsg = err.message || String(err);
            errors.push('ERR_NODE_' + nodeDef.type + ': ' + errorMsg);
            nodeTrace.push({ node: nodeDef.name, type: nodeDef.type, output: 'Failure', error: errorMsg });
            var failConns = (chain.connections.get(nodeId) || []).filter(function(c) { return c.label === 'Failure'; });
            for (var fconn of failConns) { queue.push({ nodeId: fconn.toNodeId, msg: msg }); }
        }
    }

    return { success: errors.length === 0, message: currentMsg, metadata: currentMeta, alarms: alarms, notifications: notifications, errors: errors, nodesExecuted: nodesExecuted, durationMs: Date.now() - startTime, nodeTrace: nodeTrace };
}

var entityCtx = { entityId: 'test-entity-1', entityName: 'TestSensor1', templateId: 'temp-tmpl', unsPath: '/test/sensor1' };

console.log("==========================================");
console.log("TEST B: High Temp chain with temp=95 (SHOULD trigger alarm)");
console.log("==========================================");
var rB = await executeChain({ temperature: 95, humidity: 60, _messageType: 'TELEMETRY' }, { deviceName: 'TestSensor1', deviceType: 'temperature', msgType: 'TELEMETRY' }, '764e6397-909d-4933-ba56-b5397fa0a075', entityCtx);
console.log(JSON.stringify(rB, null, 2));

console.log("\n==========================================");
console.log("TEST C: High Temp chain with temp=50 (should NOT trigger alarm)");
console.log("==========================================");
var rC = await executeChain({ temperature: 50, humidity: 60, _messageType: 'TELEMETRY' }, { deviceName: 'TestSensor1', deviceType: 'temperature', msgType: 'TELEMETRY' }, '764e6397-909d-4933-ba56-b5397fa0a075', entityCtx);
console.log(JSON.stringify(rC, null, 2));

console.log("\n==========================================");
console.log("TEST D: Low Temp chain with temp=5 (SHOULD trigger alarm)");
console.log("==========================================");
var rD = await executeChain({ temperature: 5, humidity: 60, _messageType: 'TELEMETRY' }, { deviceName: 'TestSensor1', deviceType: 'temperature', msgType: 'TELEMETRY' }, '693137bc-c308-419c-85be-37419e8e5bad', entityCtx);
console.log(JSON.stringify(rD, null, 2));

console.log("\n==========================================");
console.log("TEST E: Low Temp chain with temp=25 (should NOT trigger alarm)");
console.log("==========================================");
var rE = await executeChain({ temperature: 25, humidity: 60, _messageType: 'TELEMETRY' }, { deviceName: 'TestSensor1', deviceType: 'temperature', msgType: 'TELEMETRY' }, '693137bc-c308-419c-85be-37419e8e5bad', entityCtx);
console.log(JSON.stringify(rE, null, 2));

console.log("\n==========================================");
console.log("TEST G: QA Chain 1 with telemetry data");
console.log("==========================================");
var rG = await executeChain({ temperature: 25, pressure: 1013, _messageType: 'TELEMETRY' }, { msgType: 'TELEMETRY', deviceName: 'QADevice' }, 'b4f9ba22-5353-49a1-b81d-33afe2dd8f77', entityCtx);
console.log(JSON.stringify(rG, null, 2));

await prisma.$disconnect();
