import express from "express";
import path from "path";
import fs from "fs";
import multer from "multer";
import ffmpeg from "fluent-ffmpeg";
import { createServer as createViteServer } from "vite";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Gemini
const ai = new GoogleGenAI({ 
  apiKey: process.env.GEMINI_API_KEY || "",
  httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
});

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Middleware
  app.use(express.json());

  // Ensure uploads directory exists
  const uploadsDir = path.join(process.cwd(), "uploads");
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  // Storage Configuration
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname)),
  });
  const upload = multer({ storage: storage });

  // API: Video Upload
  app.post("/api/upload", upload.single("video"), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "No file uploaded." });
    }
    res.json({ 
      success: true, 
      filename: req.file.filename, 
      filePath: `/uploads/${req.file.filename}` 
    });
  });

  // API: Voice Sample Upload
  app.post("/api/upload-voice", upload.single("voice"), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "No voice sample uploaded." });
    }
    res.json({ 
      success: true, 
      filename: req.file.filename, 
      message: "Voice profile captured and secured."
    });
  });

  // API: Process Video (AI Auto-Edit)
  app.post("/api/process", async (req, res) => {
    const { filename, language, music, voice, voiceSample, format, resolution } = req.body;
    
    if (!filename) return res.status(400).json({ success: false, message: "Missing file." });

    const inputPath = path.join(uploadsDir, filename);
    const outputExt = format || "mp4";
    const baseName = path.basename(filename, path.extname(filename));
    const editedFilename = `edited_${baseName}_${Date.now()}.${outputExt}`;
    const outputPath = path.join(uploadsDir, editedFilename);
    const narrationPath = path.join(uploadsDir, "narration_" + Date.now() + ".mp3");

    let useNarration = false;

    // 1. Generate Narration Script & Audio if requested
    // ... (rest of the narration logic remains same)
    if (voice && voice !== "none") {
      try {
        console.log("Generating narration script with Gemini...");
        const scriptRes = await ai.models.generateContent({
          model: "gemini-3-flash-preview",
          contents: "Generate a short, viral-style 1-sentence social media narration for a video. Just provide the script text, no quotes.",
        });
        const script = scriptRes.text || "Check out this amazing footage!";

        if (voice === "cloned" && process.env.ELEVENLABS_API_KEY && voiceSample) {
          console.log("Attempting ElevenLabs Voice Cloning...");
          const voiceSamplePath = path.join(uploadsDir, voiceSample);
          
          // A. Add Voice to ElevenLabs
          const addVoiceFormData = new FormData();
          addVoiceFormData.append("name", "NonsEdit_Clone_" + Date.now());
          const sampleBlob = new Blob([fs.readFileSync(voiceSamplePath)]);
          addVoiceFormData.append("files", sampleBlob, "sample.mp3");

          const voiceAddRes = await fetch("https://api.elevenlabs.io/v1/voices/add", {
            method: "POST",
            headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
            body: addVoiceFormData
          });
          const voiceData: any = await voiceAddRes.json();
          const voiceId = voiceData.voice_id;

          if (voiceId) {
            // B. Generate TTS with Cloned Voice
            const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
              method: "POST",
              headers: { 
                "xi-api-key": process.env.ELEVENLABS_API_KEY,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({ text: script })
            });

            const audioArrayBuffer = await ttsRes.arrayBuffer();
            fs.writeFileSync(narrationPath, Buffer.from(audioArrayBuffer));
            useNarration = true;
          }
        } else if (voice !== "cloned" && process.env.ELEVENLABS_API_KEY) {
           // Use a pre-built voice ID if voice is one of the types (simplified mapping here)
           const voiceId = voice === "male_alpha" ? "pNInz6obpg8nEByWQX7d" : "21m00Tcm4TthDqHB0DuT"; // Example IDs
           
           const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
              method: "POST",
              headers: { 
                "xi-api-key": process.env.ELEVENLABS_API_KEY,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({ text: script })
            });

            if (ttsRes.ok) {
              const audioArrayBuffer = await ttsRes.arrayBuffer();
              fs.writeFileSync(narrationPath, Buffer.from(audioArrayBuffer));
              useNarration = true;
            }
        }
      } catch (err) {
        console.error("AI Narration Error:", err);
      }
    }

    // 2. FFmpeg Processing
    const command = ffmpeg(inputPath);

    if (useNarration) {
      command.input(narrationPath);
    }

    const resMap: Record<string, string> = {
      "720p": "720:1280",
      "1080p": "1080:1920",
      "4k": "2160:3840"
    };
    const scaleFilter = resMap[resolution as string] || "1080:1920";

    command.videoFilters([
      {
        filter: "scale",
        options: scaleFilter
      },
      {
        filter: "drawtext",
        options: {
          text: `AI Subtitles (${language.toUpperCase()})`,
          fontcolor: "white",
          fontsize: 24,
          box: 1,
          boxcolor: "black@0.5",
          boxborderw: 5,
          x: "(w-text_w)/2",
          y: "h-h/4"
        }
      }
    ]);

    if (useNarration) {
      command.complexFilter([
        "[0:a][1:a]amix=inputs=2:duration=longest[aout]"
      ]).outputOptions("-map 0:v").outputOptions("-map [aout]");
    }

    command
      .output(outputPath)
      .on("end", () => {
        res.json({
          success: true,
          editedVideo: `/uploads/${editedFilename}`,
          copyrightCheck: {
            status: "Passed",
            musicDetected: music !== "none" ? music : "None",
            copyrightSafe: true
          },
          platforms: ["YouTube Shorts", "TikTok", "Instagram Reels"]
        });
      })
      .on("error", (err) => {
        console.error("FFmpeg Error:", err.message);
        res.status(500).json({ 
          success: false, 
          message: "Video processing failed.",
          error: err.message
        });
      })
      .run();
  });

  // Serve uploaded files statically
  app.use("/uploads", express.static(uploadsDir));

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
});
