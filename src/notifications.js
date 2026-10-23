const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");

const sqs = new SQSClient({ region: process.env.AWS_REGION || "ap-south-1" });
const queueUrl = process.env.SQS_QUEUE_URL;

async function publishNotification(event) {
  if (!queueUrl) {
    console.log("Notification skipped (SQS_QUEUE_URL is not configured). Event type:", event.type);
    return;
  }

  await sqs.send(new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify(event)
  }));
}

module.exports = { publishNotification };
