# Roboflow Proxy API

Secure backend proxy for Roboflow inference so the API key never reaches the browser.

## Setup

1. Copy env file:

```bash
cp backend/.env.example backend/.env
```

2. Edit `backend/.env` and set:

```bash
ROBOFLOW_API_KEY=your_key_here
```

3. Start API server:

```bash
npm run start:api
```

Server runs on `http://localhost:8787` by default.

## Endpoint

### `POST /detect`

Accepts either:

- `multipart/form-data` with file field `image`
- JSON body with `imageBase64` (or `image`) string

Returns Roboflow prediction JSON:

```json
{
  "ok": true,
  "model": "marine-trash-detection/2",
  "predictions": [],
  "raw": {}
}
```

## Example frontend fetch (base64 JSON)

```js
const res = await fetch('http://localhost:8787/detect', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ imageBase64 }), // no data URL prefix needed
});
const data = await res.json();
console.log(data.predictions);
```

## Example frontend fetch (file upload)

```js
const form = new FormData();
form.append('image', file);
const res = await fetch('http://localhost:8787/detect', {
  method: 'POST',
  body: form,
});
const data = await res.json();
console.log(data.predictions);
```
