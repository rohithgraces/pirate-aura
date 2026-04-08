const express = require("express");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const fs = require("fs/promises");
const path = require("path");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const ADMIN_PANEL_KEY = process.env.ADMIN_PANEL_KEY || "Rohith";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SUPABASE_DATASET_TABLE = process.env.SUPABASE_DATASET_TABLE || "college_dataset";
const OPENROUTER_MODEL = "openai/gpt-4o-mini";
const OPENROUTER_IMAGE_MODEL = "google/gemini-2.5-flash-image";
const DATASET_PATH = path.join(__dirname, "dataset.json");
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024
    }
});

app.use(express.json());
app.use(express.static(__dirname));

function getOpenRouterHeaders() {
    return {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "HTTP-Referer": "http://localhost:3000",
        "X-Title": "College Chatbot"
    };
}

function maybeHandleUpload(req, res, next) {
    if ((req.headers["content-type"] || "").includes("multipart/form-data")) {
        return upload.single("attachment")(req, res, next);
    }

    next();
}

function parseHistory(rawHistory) {
    if (!rawHistory) {
        return [];
    }

    if (Array.isArray(rawHistory)) {
        return rawHistory;
    }

    try {
        return JSON.parse(rawHistory);
    } catch {
        return [];
    }
}

function usingSupabaseDataset() {
    return !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

function getSupabaseHeaders() {
    return {
        "Content-Type": "application/json",
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
    };
}

function getSupabaseTableUrl(query = "") {
    const baseUrl = `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/${SUPABASE_DATASET_TABLE}`;
    return query ? `${baseUrl}?${query}` : baseUrl;
}

async function readDataset() {
    if (usingSupabaseDataset()) {
        const response = await fetch(getSupabaseTableUrl("select=id,keywords,response&order=id.asc"), {
            headers: getSupabaseHeaders()
        });
        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(data.message || data.error || "Could not load dataset from Supabase.");
        }

        if (!Array.isArray(data)) {
            throw new Error("Supabase dataset response must be an array.");
        }

        return data.map((entry) => ({
            keywords: Array.isArray(entry.keywords) ? entry.keywords : [],
            response: String(entry.response || "")
        }));
    }

    const raw = await fs.readFile(DATASET_PATH, "utf8");
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
        throw new Error("Dataset file must contain an array.");
    }

    return parsed;
}

function normalizeDatasetEntry(entry) {
    return {
        keywords: Array.isArray(entry?.keywords)
            ? entry.keywords
                .map((keyword) => String(keyword || "").trim())
                .filter(Boolean)
            : [],
        response: String(entry?.response || "").trim()
    };
}

function validateDataset(dataset) {
    if (!Array.isArray(dataset)) {
        throw new Error("Dataset must be an array.");
    }

    const normalized = dataset.map(normalizeDatasetEntry);
    const hasInvalidEntry = normalized.some((entry) => entry.keywords.length === 0 || !entry.response);

    if (hasInvalidEntry) {
        throw new Error("Each dataset item needs at least one keyword and one response.");
    }

    return normalized;
}

async function writeDataset(dataset) {
    if (usingSupabaseDataset()) {
        const deleteResponse = await fetch(getSupabaseTableUrl("id=gt.0"), {
            method: "DELETE",
            headers: {
                ...getSupabaseHeaders(),
                Prefer: "return=minimal"
            }
        });

        if (!deleteResponse.ok) {
            const deleteData = await deleteResponse.json().catch(() => ({}));
            throw new Error(deleteData.message || deleteData.error || "Could not clear existing Supabase dataset.");
        }

        if (dataset.length > 0) {
            const insertResponse = await fetch(getSupabaseTableUrl(), {
                method: "POST",
                headers: {
                    ...getSupabaseHeaders(),
                    Prefer: "return=minimal"
                },
                body: JSON.stringify(
                    dataset.map((entry) => ({
                        keywords: entry.keywords,
                        response: entry.response
                    }))
                )
            });

            if (!insertResponse.ok) {
                const insertData = await insertResponse.json().catch(() => ({}));
                throw new Error(insertData.message || insertData.error || "Could not save dataset to Supabase.");
            }
        }

        return;
    }

    await fs.writeFile(DATASET_PATH, `${JSON.stringify(dataset, null, 2)}\n`, "utf8");
}

function hasAdminAccess(req) {
    if (!ADMIN_PANEL_KEY) {
        return true;
    }

    const incomingKey = req.headers["x-admin-key"] || req.body?.adminKey || "";
    return incomingKey === ADMIN_PANEL_KEY;
}

async function buildAttachmentContent(file) {
    if (!file) {
        return null;
    }

    if (file.mimetype.startsWith("image/")) {
        const base64Image = file.buffer.toString("base64");
        return [
            {
                type: "text",
                text: `The user uploaded an image named "${file.originalname}". Analyze it and answer the user's question about it.`
            },
            {
                type: "image_url",
                image_url: {
                    url: `data:${file.mimetype};base64,${base64Image}`
                }
            }
        ];
    }

    if (file.mimetype === "application/pdf") {
        const pdfData = await pdfParse(file.buffer);
        const extractedText = (pdfData.text || "").trim().slice(0, 16000);

        if (!extractedText) {
            throw new Error("Could not read text from the uploaded PDF.");
        }

        return `The user uploaded a PDF file named "${file.originalname}". Use this extracted text to answer the question:\n\n${extractedText}`;
    }

    const extractedText = file.buffer.toString("utf8").trim().slice(0, 16000);
    if (!extractedText) {
        throw new Error("The uploaded file is empty or unsupported.");
    }

    return `The user uploaded a file named "${file.originalname}". Use this file content to answer the question:\n\n${extractedText}`;
}

app.post("/api/chat", maybeHandleUpload, async (req, res) => {
    try {
        if (!OPENROUTER_API_KEY) {
            return res.status(500).json({
                error: "Missing OPENROUTER_API_KEY. Set it before starting the server."
            });
        }

        const body = req.body || {};
        const message = body.message;
        const history = parseHistory(body.history);
        if (!message) {
            return res.status(400).json({ error: "Message is required." });
        }

        const formattedHistory = history
            .filter((item) => item && item.role && item.content)
            .map((item) => ({
                role: item.role === "ai" ? "assistant" : item.role,
                content: item.content
            }));

        const attachmentContent = await buildAttachmentContent(req.file);
        const userContent = [];

        if (attachmentContent) {
            if (Array.isArray(attachmentContent)) {
                userContent.push(...attachmentContent);
            } else {
                userContent.push({
                    type: "text",
                    text: attachmentContent
                });
            }
        }

        userContent.push({
            type: "text",
            text: req.file
                ? `User question about the uploaded file: ${message}`
                : message
        });

        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: getOpenRouterHeaders(),
            body: JSON.stringify({
                model: OPENROUTER_MODEL,
                messages: [
                    {
                        role: "system",
                        content: "You are Pirate Aura, a professional and helpful AI assistant. Answer the user's exact question directly in simple English. When the user uploads an image or file, read it carefully and answer based on that content. Do not assume the topic. If the user asks for the meaning of a name, explain that name. If the user asks a short follow-up like 'yes', use the recent chat history to understand it. Keep answers clear, relevant, and concise."
                    },
                    ...formattedHistory.map((item) => ({
                        role: item.role,
                        content: item.content
                    })),
                    {
                        role: "user",
                        content: userContent
                    }
                ]
            })
        });

        const data = await response.json();

        if (!response.ok) {
            return res.status(response.status).json({
                error: data.error?.message || "OpenRouter request failed."
            });
        }

        const reply = data.choices?.[0]?.message?.content || "I could not generate a response.";
        return res.json({ reply });
    } catch (error) {
        return res.status(500).json({
            error: error.message || "Unexpected server error."
        });
    }
});

app.get("/api/dataset", async (req, res) => {
    try {
        const dataset = await readDataset();
        return res.json({
            dataset,
            protected: !!ADMIN_PANEL_KEY,
            storage: usingSupabaseDataset() ? "supabase" : "file"
        });
    } catch (error) {
        return res.status(500).json({
            error: error.message || "Could not load dataset."
        });
    }
});

async function saveDatasetHandler(req, res) {
    try {
        if (!hasAdminAccess(req)) {
            return res.status(401).json({
                error: "Invalid admin key."
            });
        }

        const validatedDataset = validateDataset(req.body?.dataset);
        await writeDataset(validatedDataset);

        return res.json({
            success: true,
            count: validatedDataset.length,
            storage: usingSupabaseDataset() ? "supabase" : "file"
        });
    } catch (error) {
        const statusCode = error.message && error.message.includes("Dataset") || error.message && error.message.includes("Each dataset item")
            ? 400
            : 500;

        return res.status(statusCode).json({
            error: error.message || "Could not save dataset."
        });
    }
}

app.put("/api/dataset", saveDatasetHandler);
app.post("/api/dataset", saveDatasetHandler);

app.post("/api/generate-image", async (req, res) => {
    try {
        if (!OPENROUTER_API_KEY) {
            return res.status(500).json({
                error: "Missing OPENROUTER_API_KEY. Set it before starting the server."
            });
        }

        const { prompt } = req.body || {};
        if (!prompt) {
            return res.status(400).json({ error: "Prompt is required." });
        }

        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: getOpenRouterHeaders(),
            body: JSON.stringify({
                model: OPENROUTER_IMAGE_MODEL,
                modalities: ["image", "text"],
                image_config: {
                    aspect_ratio: "1:1"
                },
                messages: [
                    {
                        role: "system",
                        content: "Generate a clear, useful image that matches the user's prompt. Also provide a short one-line caption."
                    },
                    {
                        role: "user",
                        content: prompt
                    }
                ]
            })
        });

        const data = await response.json();

        if (!response.ok) {
            return res.status(response.status).json({
                error: data.error?.message || "Image generation request failed."
            });
        }

        const message = data.choices?.[0]?.message || {};
        const imageUrl = message.images?.[0]?.image_url?.url || "";
        const reply = message.content || "I generated an image for you.";

        if (!imageUrl) {
            return res.status(502).json({
                error: "No image was returned by the model."
            });
        }

        return res.json({ reply, imageUrl });
    } catch (error) {
        return res.status(500).json({
            error: error.message || "Unexpected server error."
        });
    }
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
