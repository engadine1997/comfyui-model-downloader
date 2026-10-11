# Model Downloader for ComfyUI

Download models from CivitAI, Hugging Face or any direct link into ComfyUI's model folders. Open it with the
**Models** button in the top action bar (next to Media / Run), or bind the `Toggle Model Downloader` command to a key.

## Usage

1. Paste a link and press Enter (pasting runs Inspect automatically; dropping a link on the window works too).
2. Tick the files you want, edit the file names if needed, and pick the folder and an optional subfolder
   (for example `loras` + `x_family` saves to `models/loras/x_family/<name>`).
3. Press **Download**. Progress, speed and ETA are in the **Queue** tab; finished and failed items go to **History**.

## Sources

- **CivitAI** (`civitai.com` and `civitai.red`): a model page, a `?modelVersionId=` link, a `/model-versions/` link or an
  `/api/download/models/` link. Pick the version and the files (model, VAE, config...). The folder is chosen from the model type
  and the base model is offered as a subfolder suggestion.
- **Hugging Face**: a repo, a `/tree/<rev>/<folder>` link, or a `/blob/` or `/resolve/` file link. Repos list their files with a
  filter and a "Model files only" toggle, so you only fetch what you need. Repos laid out for ComfyUI
  (`split_files/vae/...`) get the matching folder per file.
- **Direct link**: any URL that serves a file. The name comes from `Content-Disposition` or the URL.

## Features

- Per-file folder, shared subfolder (with autocomplete and recent/base-model chips), and rename before download.
- CivitAI file naming: keep the original name, or use the model name / model name + version.
- If the file exists: rename (`name (1)`), skip or overwrite. Existing files are flagged before you start.
- Pause, resume, cancel and retry. Partial files (`.part`) resume with HTTP Range, also after a restart or a network drop
  (automatic retries).
- SHA256 verification when the source publishes a hash (CivitAI, Hugging Face LFS files). `.safetensors` headers are validated.
- Refuses HTML pages saved in place of a model (typical for login-required CivitAI files) and checks free disk space.
- Parallel downloads (default 2). Toast notification when a download finishes, and the model lists in the graph refresh.
- Queue and history persist across restarts (`user/model_downloader/jobs.json`).

## Settings (gear button)

- **CivitAI API key**: needed for login-only or early-access files (civitai.com/user/account > API Keys).
- **Hugging Face token**: needed for gated or private repos (accept the repo's terms on the website too).
- Tokens are stored in `user/model_downloader/settings.json`, are never returned to the browser, and are only sent to
  CivitAI / Hugging Face hosts (not to the CDN hosts they redirect to). Environment variables `CIVITAI_API_KEY` and `HF_TOKEN` also work.
- Simultaneous downloads, and whether to allow links to local network addresses.

## Security notes

- Files can only be written inside registered model folders; names and subfolders are validated against path traversal.
- Links to loopback, link-local and private (LAN) addresses are blocked by default, including via redirects.
- ComfyUI has no authentication. If you run with `--listen`, anyone who can reach the server can queue downloads,
  so only do that on a trusted network.

## Disclaimer

This was entirely vibe-coded with Claude Code. I am a programmer and have reviewed the code, and it works well in my testing and for my use cases.