# Pirate Aura Chatbot

A web chatbot with:

- chat UI in `index.html`
- Node/Express backend in `server.js`
- OpenRouter API integration
- image and file upload support
- text-to-speech, copy buttons, dark mode, and chat history

## Run locally

1. Install dependencies:

```bash
npm install
```

2. Set your OpenRouter API key:

```bash
OPENROUTER_API_KEY=your_key
```

On Windows PowerShell:

```powershell
$env:OPENROUTER_API_KEY="your_key"
```

3. Start the server:

```bash
npm start
```

4. Open:

`http://localhost:3000/index.html`

## Files

- `index.html` - frontend UI
- `server.js` - backend API server
- `package.json` - project dependencies and scripts
- `package-lock.json` - locked dependency versions

## Deployment

Deploy on a platform that supports Node.js, such as Render or Railway.

Set this environment variable in deployment settings:

- `OPENROUTER_API_KEY`
