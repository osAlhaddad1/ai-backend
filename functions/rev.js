import { RevAiApiClient } from 'revai-node-sdk';

/**
 * Transcript helper that wraps the Rev‑AI SDK.
 * – polls **every 7 s** and logs the current job.status
 * – on *failed / revoked / error* emits the Rev‑AI `failure_detail`
 * – optional overall timeout (default 15 min)
 */
class Transcript {
  /**
   * @param {(msg:string)=>void}   logFn    – logger injected by server.js
   * @param {number}               timeoutS – max seconds before we give up
   */
  constructor(logFn = console.log, timeoutS = 900) {
    this.log   = logFn;
    this.timeoutS = timeoutS;

    // Use env‑var if present, otherwise fall back to a hard‑coded token.
    this.client = new RevAiApiClient(
      process.env.REV_AI_ACCESS_TOKEN ||
      '02IGtLwfVlc7IY73cPimHCMzAmfScgTWfy-IVldrf8TWXhjlMWHOljGeSc-Vgfnjqog4AMZ8xcjL9vEaD9Sdk_sVFdKdg'
    );
  }

  /**
   * Submit the file to Rev‑AI and return the plain‑text transcript when ready.
   * Throws on Rev‑AI *failed* / *revoked* / *error* or overall timeout.
   */
  async generate(filePath) {
    // 1️⃣  Submit job
    const job = await this.client.submitJobLocalFile(filePath, {
      language: 'fr',
      metadata: 'auto‑transcribed',
      skip_punctuation: false,
      // speaker_channels_count intentionally omitted – let Rev‑AI auto‑detect
    });
    this.log(`📤 Rev‑AI job submitted (id=${job.id})`);

    // 2️⃣  Poll every 7 s
    const POLL_MS = 7000;
    let elapsed   = 0;
    let details   = job;

    while (true) {
      await new Promise(res => setTimeout(res, POLL_MS));
      elapsed += POLL_MS / 1000;

      details = await this.client.getJobDetails(job.id);
      this.log(`⏳ still transcribing (${elapsed}s)… status=${details.status}`);

      // Success
      if (details.status === 'transcribed') break;

      // Hard failure reported by Rev‑AI
      if (['failed', 'revoked', 'error'].includes(details.status)) {
        const reason = details.failure_detail || details.failure || 'unknown reason';
        throw new Error(`Rev‑AI job ${job.id} ended with status "${details.status}" – ${reason}`);
      }

      // Timeout guard
      if (elapsed > this.timeoutS) {
        throw new Error(`Rev‑AI job ${job.id} timed‑out after ${this.timeoutS}s`);
      }
    }

    // 3️⃣  Retrieve transcript text
    return await this.client.getTranscriptText(job.id);
  }
}

export default Transcript;
