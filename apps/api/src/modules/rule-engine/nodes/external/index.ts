import { registerNode } from '../../registry.js';
import { restApiCallHandler, REST_API_CALL_TYPE } from './rest-api-call.js';
import { mqttHandler, mqttLifecycle, MQTT_TYPE } from './mqtt.js';
import { sendEmailHandler, SEND_EMAIL_TYPE } from './send-email.js';
import { sendSmsHandler, SEND_SMS_TYPE } from './send-sms.js';
import { sendNotificationHandler, SEND_NOTIFICATION_TYPE } from './send-notification.js';
import { sendToSlackHandler, SEND_TO_SLACK_TYPE } from './send-to-slack.js';

/**
 * External rule nodes (rule chains, 2026-11-03; spec §6, §7 External, §12).
 * `registerAllNodes()` (../index.ts) calls this on every engine start;
 * registering again replaces the same handlers.
 *
 * The six BUILT external types of the catalogue: REST API call, MQTT, Send
 * email, Send SMS, Send notification, Send to Slack. AI request (later) and
 * the vendor nodes (none) have no handler — the engine sends their messages
 * to `Failure` as UNSUPPORTED_NODE.
 */
export function registerExternalNodes(): void {
  registerNode(REST_API_CALL_TYPE, restApiCallHandler);
  registerNode(MQTT_TYPE, mqttHandler, mqttLifecycle);
  registerNode(SEND_EMAIL_TYPE, sendEmailHandler);
  registerNode(SEND_SMS_TYPE, sendSmsHandler);
  registerNode(SEND_NOTIFICATION_TYPE, sendNotificationHandler);
  registerNode(SEND_TO_SLACK_TYPE, sendToSlackHandler);
}
