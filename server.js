// server.js (for live-translation-ws-server)
const express = require('express');
const WebSocket = require('ws');
const fs = require('fs');
const { OpenAI } = require('openai');
const twilio = require('twilio');
const { Readable } = require('stream');
const fetch = require('node-fetch');

const app = express();
const port = process.env.PORT || 8080;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const twilioClient = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);
const FROM_PHONE = process.env.TWILIO_PHONE;

const wss = new WebSocket.Server({ noServer: true });
const bufferMap = new Map(); // sid => { buffer, participant }

async function bufferToAudioFile(buffer) {
  const path = `/tmp/audio-${Date.now()}.wav`;
  fs.writeFileSync(path, buffer);
  return path;
}

async function handleTranslation(buffer, speakerSid, speakerRole) {
  const audioPath = await bufferToAudioFile(buffer);

  // Transcribe with Whisper
  const transcription = await openai.audio.transcriptions.create({
    file: fs.createReadStream(audioPath),
    model: 'whisper-1',
    response_format: 'text',
  });

  console.log(`🎙️ [${speakerRole}] ${transcription}`);

  // Translate via GPT
  const translation = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [
      { role: 'system', content: 'Translate this naturally between English and Spanish.' },
      { role: 'user', content: transcription }
    ]
  });

  const translatedText = translation.choices[0].message.content;
  console.log(`🗣️ Translation for ${speakerRole}: ${translatedText}`);

  // Target the other participant
  let targetSid = null;
  for (const [sid, info] of bufferMap.entries()) {
    if (sid !== speakerSid) {
      targetSid = sid;
      break;
    }
  }

  if (!targetSid) return console.warn('❌ No other participant to speak to.');

  // Send TwiML <Say> to the other call
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: 'Polly.Miguel', language: 'es-US' }, translatedText);

  try {
    await twilioClient.calls(targetSid).update({ twiml: twiml.toString() });
    console.log(`📤 Spoke to ${targetSid}`);
  } catch (err) {
    console.error(`❌ Failed to update call ${targetSid}:`, err);
  }
}

wss.on('connection', (ws, req) => {
  const urlParams = new URLSearchParams(req.url.replace(/^.*\?/, ''));
  const participant = urlParams.get('participant') || 'unknown';
  const sid = urlParams.get('sid') || `sid-${Date.now()}`;

  console.log(`🔗 New connection from ${participant} (${sid})`);

  bufferMap.set(sid, { buffer: Buffer.alloc(0), participant });

  ws.on('message', async (msg) => {
    const data = bufferMap.get(sid);
    if (!data) return;

    data.buffer = Buffer.concat([data.buffer, msg]);

    if (data.buffer.length > 20000) { // ~1.5s of audio
      const bufferCopy = Buffer.from(data.buffer);
      data.buffer = Buffer.alloc(0);
      await handleTranslation(bufferCopy, sid, participant);
    }
  });

  ws.on('close', () => {
    console.log(`❌ Connection closed: ${participant} (${sid})`);
    bufferMap.delete(sid);
  });
});

const server = app.listen(port, () => {
  console.log(`🌐 Translator server listening on port ${port}`);
});

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});
