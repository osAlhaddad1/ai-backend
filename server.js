import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import helmet from 'helmet';
import crypto from 'crypto';

// --- Polyfill global fetch (if needed for older Node.js versions) ---
if (!globalThis.fetch) {
  globalThis.fetch = (await import('node-fetch')).default;
}

import Transcript from './functions/rev.js';
import Gemini from './functions/gemini.js';

/*****************************************************************
 * Minimal helper for timestamped, emoji‑flavoured logging.
 *****************************************************************/
function log(jobId, message) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] Job ${jobId}: ${message}`);
}

/*****************************************************************
 * Express setup
 *****************************************************************/
const app = express();
app.use(helmet());
app.use(express.json());

// --- SECURE CORS CONFIGURATION ---
// This is the correct, secure way to handle CORS.
// It reads the allowed frontend URL from your .env file.
const corsOptions = {
  origin: "*",
  optionsSuccessStatus: 200,
};
// Make sure FRONTEND_URL in your .env file matches your browser's origin
// (e.g., FRONTEND_URL=http://localhost:63342)
app.use(cors(corsOptions));


// --- SECURE MULTER CONFIGURATION ---
const UPLOAD_PATH = 'uploads/';

// FIX: Automatically create the uploads directory if it doesn't exist.
// This prevents errors if the folder is missing.
fs.mkdir(UPLOAD_PATH, { recursive: true }).catch(console.error);

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB (matching your frontend)

// FIX: Expanded list of common audio and video mime types.
// This was the likely cause of the "400 Bad Request" error.
const allowedMimeTypes = [
  // Audio
  'audio/mpeg', // .mp3
  'audio/mp4', // .mp4, .m4a
  'audio/wav', // .wav
  'audio/x-wav', // .wav
  'audio/webm', // .webm
  'audio/ogg', // .ogg
  'audio/x-m4a', // .m4a

  // Video (since your frontend accepts video/*)
  'video/mp4', // .mp4
  'video/webm', // .webm
  'video/quicktime', // .mov
  'video/x-msvideo' // .avi
];

const upload = multer({
  dest: UPLOAD_PATH,
  limits: {
    fileSize: MAX_FILE_SIZE,
  },
  fileFilter: (req, file, cb) => {
    // Log the received file type for easy debugging in the future.
    console.log(`[Multer] Checking file: ${file.originalname}, MIME Type: ${file.mimetype}`);

    if (allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true); // Accept the file
    } else {
      // Reject the file with a specific error message.
      const errorMsg = `Invalid file type: '${file.mimetype}'. Only specific audio/video formats are allowed.`;
      console.log(`[Multer] REJECTED: ${errorMsg}`);
      cb(new Error(errorMsg), false);
    }
  },
});

const PORT = process.env.PORT || 3000;

/*****************************************************************
 * In‑memory job store with TTL cleanup
 *****************************************************************/
const jobs = {};
const JOB_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/*****************************************************************
 * Middleware for job authorization
 *****************************************************************/
function authorizeJob(req, res, next) {
    const { jobId } = req.params;
    const authHeader = req.headers['authorization'];
    const job = jobs[jobId];

    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }

    // Securely check for the Bearer token
    if (!authHeader || authHeader !== `Bearer ${job.accessToken}`) {
        return res.status(403).json({ error: 'Forbidden: Invalid access token' });
    }

    req.job = job;
    next();
}


/*****************************************************************
 * Kick off Gemini analysis once we have BOTH the transcript and books.
 *****************************************************************/
async function tryStartAnalysis(jobId) {
  const job = jobs[jobId];
  if (!job) return;
  if (job.status.startsWith('analysis') || job.status === 'finished' || job.status === 'error') return;

  if (job.transcript && Array.isArray(job.selectedBooks) && job.selectedBooks.length > 0) {
    job.status = 'analysis_started';
    log(jobId, '🤖 starting Gemini analysis');
    await getAnalysis(jobId);
  }
}

/*****************************************************************
 * Perform Gemini analysis
 *****************************************************************/
async function getAnalysis(jobId) {
  const job = jobs[jobId];
  if (!job) return;

  try {
    log(jobId, `🗂️  loading ${job.selectedBooks.length} book(s)`);
    const bookData = await Promise.all(
        job.selectedBooks.map(async (book) => ({
            title: book.title,
            text: await fs.readFile(book.text, 'utf8'),
        }))
    );
    log(jobId, '📚 books loaded');

    log(jobId, '🤖 calling Gemini …');
    const geminiClient = new Gemini(job.transcript, bookData);
    const analysisJson = await geminiClient.getResponse();

    log(jobId, '✅ Gemini analysis finished');
    job.status = 'finished';
    job.analysis = analysisJson;
    job.transcript = null; // Clear large text field to save memory

  } catch (err) {
    log(jobId, `❌ Gemini analysis exception: ${err.message}`);
    job.status = 'error';
    job.error = 'An error occurred during AI analysis.';
    console.error(`[Job ${jobId}] Gemini Error Details:`, err);
  }
}

/*****************************************************************
 * Routes
 *****************************************************************/
app.get('/', (req, res) => {
  res.send('<h1>Server is running securely</h1>');
});

// 1️⃣ Upload audio & start Rev‑AI transcription
app.post('/start', upload.single('file'), async (req, res, next) => {
  if (!req.file) {
    // This case happens if the fileFilter passed but something else went wrong.
    return res.status(400).json({ error: 'No file was uploaded or file was empty.' });
  }

  const jobId = uuidv4();
  const accessToken = crypto.randomBytes(32).toString('hex');
  log(jobId, `📥 received file ${req.file.originalname}`);

  jobs[jobId] = {
    id: jobId, // Good practice to have the ID inside the job object itself
    status: 'transcribing',
    transcript: null,
    analysis: null,
    selectedBooks: [],
    filePath: req.file.path,
    error: null,
    accessToken: accessToken,
  };

  setTimeout(() => {
    if (jobs[jobId]) {
      log(jobId, '🧹 Job expired, cleaning up.');
      if (jobs[jobId].filePath) {
        fs.unlink(jobs[jobId].filePath).catch(err => console.error(`Cleanup failed for ${jobs[jobId].filePath}: ${err.message}`));
      }
      delete jobs[jobId];
    }
  }, JOB_TTL_MS);

  // Respond immediately with the jobId and the secret token
  res.status(202).json({ jobId, accessToken });

  // ---- Async workflow begins ----
  const transcriptClient = new Transcript();
  try {
    log(jobId, '🎙️  starting transcription …');
    const transcriptText = await transcriptClient.generate(
      req.file.path,
      msg => log(jobId, msg)
    );

    jobs[jobId].transcript = transcriptText;
    jobs[jobId].status = 'transcribed';
    log(jobId, '✅ transcription finished');

    await tryStartAnalysis(jobId);
  } catch (err) {
    log(jobId, `❌ transcription error: ${err.message}`);
    if (jobs[jobId]) {
      jobs[jobId].status = 'error';
      jobs[jobId].error = 'Transcription failed.';
      console.error(`[Job ${jobId}] Transcription Error Details:`, err);
    }
  } finally {
    // Clean up the uploaded file once transcription is done (or has failed)
    if (jobs[jobId] && jobs[jobId].filePath) {
      await fs.unlink(jobs[jobId].filePath);
      jobs[jobId].filePath = null; // Mark as deleted
      log(jobId, `🗑️ cleaned up file ${req.file.path}`);
    }
  }
}, (err, req, res, next) => { // Multer-specific error handler
    if (err instanceof multer.MulterError) {
        // e.g., 'File too large'
        return res.status(413).json({ error: `File upload error: ${err.message}` });
    } else if (err) {
        // This catches errors from our custom `fileFilter`
        return res.status(400).json({ error: err.message });
    }
});


// 2️⃣ Receive selected books list (now with authorization)
app.post('/booksselection/:jobId', authorizeJob, async (req, res) => {
  const job = req.job;
  const { jobId } = req.params;

  job.selectedBooks = req.body.selectedBooks || [];
  // FIX: was logging `job.id` which was undefined. Using jobId from params.
  log(jobId, `📚 received ${job.selectedBooks.length} selected book(s)`);
  res.sendStatus(200);

  await tryStartAnalysis(jobId);
});

// 3️⃣ Poll job status (now with authorization)
app.get('/status/:jobId', authorizeJob, (req, res) => {
  const job = req.job;
  res.json({
    status: job.status,
    analysis: job.analysis,
    error: job.error,
  });
});

/*****************************************************************/
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));