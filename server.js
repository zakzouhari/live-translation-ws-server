// server.js
const express = require('express');
const WebSocket = require('ws');
const fs = require('fs');
const { Readable } = require('stream');
const { OpenAI } = require('openai');
const twilio = require('twilio');

const app = express();
const port = process.env.PORT || 8080;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const TWILIO_PHONE = process.env.TWILIO_PHONE;

// WebSocket server
const wss = new WebSocket.Server({ noServer: true });

// TEMP: Map to store audio per connection
const connectionBuffers = new Map();

// Helper: Convert buffer to audio file for Whisper
const bufferToAudioFile = async (buffer) => {
  const filePath = '/tmp/audio.wav';
  fs.writeFileSync(filePath, buffer);
  return filePath;
};

// Whisper + GPT + generate <Say>
async function processAudioBuffer(buffer, responseUrl) {
  try {
    const audioFile = await bufferToAudioFile(buffer);

    // Transcribe with Whisper
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioFile),
      model: 'whisper-1',
      response_format: 'text',
    });

    console.log('🎙️ Transcription:', transcription);

    // Translate via GPT
    const translation = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are a live phone call translator. Translate naturally and briefly.' },
        { role: 'user', content: `Translate this to Spanish (or back to English if it's Spanish): ${transcription}` },
      ],
    });

    const translatedText = translation.choices[0].message.content;
    console.log('🗣️ Translated:', translatedText);

    // Respond back using Twilio <Say>
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say({ voice: 'Polly.Miguel' }, translatedText);

    // POST TwiML to the Twilio stream (or webhook depending on setup)
    const res = await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml' },
      body: twiml.toString(),
    });

    console.log('📤 TTS Response Sent');
  } catch (err) {
    console.error('❌ Error during translation:', err);
  }
}

wss.on('connection', (ws, req) => {
  console.log('🔗 WebSocket connection opened');
  let buffer = Buffer.alloc(0);

  ws.on('message', async (msg) => {
    buffer = Buffer.concat([buffer, msg]);

    // Wait ~1.5s of audio (around 32 chunks)
    if (buffer.length > 15000) {
      // Replace with actual Twilio participant stream callback URL
      const responseUrl = 'https://handler-for-twilio-response.com/twiml';
      await processAudioBuffer(buffer, responseUrl);
      buffer = Buffer.alloc(0);
    }
  });

  ws.on('close', () => {
    console.log('🔌 WebSocket connection closed');
  });
});

// Attach WS server to HTTP server
const server = app.listen(port, () => {
  console.log(`🌐 Server listening on port ${port}`);
});
server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});
