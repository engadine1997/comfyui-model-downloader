import asyncio
import hashlib
import ipaddress
import json
import logging
import os
import re
import shutil
import socket
import threading
import time
import urllib.parse
import uuid
from collections import OrderedDict

import requests
from aiohttp import web

import folder_paths
from server import PromptServer

log = logging.getLogger("ModelDownloader")

STATE_DIR = os.path.join(folder_paths.get_user_directory(), "model_downloader")
SETTINGS_FILE = os.path.join(STATE_DIR, "settings.json")
JOBS_FILE = os.path.join(STATE_DIR, "jobs.json")
os.makedirs(STATE_DIR, exist_ok=True)

USER_AGENT = "Mozilla/5.0 (compatible; ComfyUI-ModelDownloader/1.0)"
CIVITAI_HOST = re.compile(r"(^|\.)civitai\.(com|red)$")
HF_HOSTS = ("huggingface.co", "hf.co")
INVALID_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
MODEL_EXTS = {".safetensors", ".sft", ".ckpt", ".pt", ".pt2", ".pth", ".bin", ".gguf", ".onnx", ".pkl", ".engine"}
HIDDEN_FOLDERS = {"custom_nodes", "datasets"}
MAX_HISTORY = 300
RETRIES = 4

# Networks a download link must not point at (loopback, link-local, LAN) unless the user opts in.
LOCAL_NETS = [ipaddress.ip_network(n) for n in (
    "0.0.0.0/8", "10.0.0.0/8", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16",
    "::/128", "::1/128", "fc00::/7", "fe80::/10")]

CIVITAI_TYPES = {
    "Checkpoint": "checkpoints", "LORA": "loras", "LoCon": "loras", "DoRA": "loras", "TextualInversion": "embeddings",
    "Hypernetwork": "hypernetworks", "Controlnet": "controlnet", "VAE": "vae", "Upscaler": "upscale_models",
}
# Directory names (or filename words) that identify a model folder in repos laid out for ComfyUI.
FOLDER_HINTS = {
    "diffusion_models": "diffusion_models", "unet": "diffusion_models", "transformer": "diffusion_models",
    "text_encoders": "text_encoders", "text_encoder": "text_encoders", "clip": "text_encoders",
    "vae": "vae", "loras": "loras", "lora": "loras", "controlnet": "controlnet", "clip_vision": "clip_vision",
    "upscale_models": "upscale_models", "checkpoints": "checkpoints", "embeddings": "embeddings",
    "model_patches": "model_patches", "style_models": "style_models", "audio_encoders": "audio_encoders",
}

routes = PromptServer.instance.routes


class DownloadError(Exception):
    pass


class Stopped(Exception):
    pass


class Incomplete(Exception):
    pass


# ---------------------------------------------------------------- settings ---

_settings_lock = threading.Lock()
_settings = {"civitai_key": "", "hf_token": "", "max_concurrent": 2, "allow_local": False}


def load_settings():
    if os.path.isfile(SETTINGS_FILE):
        with open(SETTINGS_FILE, encoding="utf-8") as f:
            _settings.update({k: v for k, v in json.load(f).items() if k in _settings})


def write_json(path, data):
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1)
    os.replace(tmp, path)


def token_for(url):
    p = urllib.parse.urlsplit(url)
    host = p.hostname or ""
    if p.scheme != "https":
        return ""
    if CIVITAI_HOST.search(host):
        return _settings["civitai_key"] or os.environ.get("CIVITAI_API_KEY", "")
    if host in HF_HOSTS or host == "www.huggingface.co":
        return _settings["hf_token"] or os.environ.get("HF_TOKEN", "")
    return ""


def public_settings():
    def hint(v):
        return f"••••{v[-4:]}" if len(v) > 8 else ("••••" if v else "")
    s = _settings
    return {"civitai_key": hint(s["civitai_key"]), "hf_token": hint(s["hf_token"]),
            "max_concurrent": s["max_concurrent"], "allow_local": s["allow_local"]}


# -------------------------------------------------------------------- http ---

def check_url(url):
    p = urllib.parse.urlsplit(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        raise DownloadError("Only http:// and https:// links are supported")
    if _settings["allow_local"]:
        return
    try:
        infos = socket.getaddrinfo(p.hostname, p.port or (443 if p.scheme == "https" else 80), type=socket.SOCK_STREAM)
    except socket.gaierror:
        raise DownloadError(f"Could not resolve host '{p.hostname}'")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.version == 6 and ip.ipv4_mapped:
            ip = ip.ipv4_mapped
        if any(ip in net for net in LOCAL_NETS):
            raise DownloadError(f"'{p.hostname}' is a local address. Enable 'Allow local network links' in Settings to download from it")


def open_url(url, method="GET", headers=None, stream=False, **kw):
    """Follows redirects by hand so every hop is checked and only CivitAI / Hugging Face hops carry a token."""
    for _ in range(10):
        check_url(url)
        h = {"User-Agent": USER_AGENT, **(headers or {})}
        token = token_for(url)
        if token:
            h["Authorization"] = f"Bearer {token}"
        r = requests.request(method, url, headers=h, stream=stream, allow_redirects=False, timeout=(15, 30), **kw)
        if r.status_code in (301, 302, 303, 307, 308) and r.headers.get("Location"):
            url = urllib.parse.urljoin(url, r.headers["Location"])
            r.close()
            if method == "POST":
                method, kw = "GET", {}
            continue
        return r
    raise DownloadError("Too many redirects")


def auth_hint(url, code):
    host = urllib.parse.urlsplit(url).hostname or ""
    if CIVITAI_HOST.search(host):
        return f"CivitAI refused the request (HTTP {code}). This file needs an API key: add one in Settings (civitai.com/user/account > API Keys)"
    if host in HF_HOSTS:
        return f"Hugging Face refused the request (HTTP {code}). The repo may not exist, or is gated/private: accept its terms on the website and add an access token in Settings"
    return f"The server refused the request (HTTP {code})"


def html_error(url):
    if CIVITAI_HOST.search(urllib.parse.urlsplit(url).hostname or ""):
        return "CivitAI sent a login page instead of the file. This download needs an API key: add one in Settings"
    return "The server sent a web page instead of a file"


def check_status(r, url):
    if r.status_code in (401, 403):
        raise DownloadError(auth_hint(url, r.status_code))
    if r.status_code == 404:
        raise DownloadError("Not found (HTTP 404). Check the link")
    if 400 <= r.status_code < 500 and r.status_code not in (408, 429):
        raise DownloadError(f"The server rejected the request (HTTP {r.status_code})")
    r.raise_for_status()


def get_json(url, **kw):
    r = open_url(url, **kw)
    with r:
        check_status(r, url)
        return r.json(), r.links.get("next", {}).get("url")


# ------------------------------------------------------------- destinations ---

def is_media_dir(path):
    """Core registers output/<type> folders so save nodes have somewhere to write; they are not download targets."""
    path = os.path.realpath(path)
    for d in (folder_paths.get_output_directory(), folder_paths.get_input_directory(), folder_paths.get_temp_directory()):
        d = os.path.realpath(d)
        if os.path.commonpath([d, path]) == d:
            return True
    return False


def roots():
    """Model folders ComfyUI knows about (including ones registered by other custom nodes), keyed by a stable id."""
    out = {}
    for name, (paths, _) in folder_paths.folder_names_and_paths.items():
        if name in HIDDEN_FOLDERS:
            continue
        order = sorted((i for i, p in enumerate(paths) if not is_media_dir(p)), key=lambda i: os.path.basename(paths[i]) != name)
        for n, i in enumerate(order):
            base = os.path.basename(paths[i])
            label = name if n == 0 and base == name else f"{name} ({os.path.basename(os.path.dirname(paths[i]))}/{base})"
            out[name if n == 0 else f"{name}:{i}"] = {"label": label, "path": os.path.abspath(paths[i])}
    out["models"] = {"label": "models (root)", "path": os.path.abspath(folder_paths.models_dir)}
    return out


def check_name(name):
    name = (name or "").strip()
    if not name or name in (".", "..") or INVALID_NAME.search(name) or name.endswith("."):
        raise DownloadError(f"Invalid name '{name}'")
    return name


def split_subdir(subdir):
    return [check_name(p) for p in re.split(r"[\\/]+", subdir or "") if p.strip()]


def dest_path(root, subdir, name):
    rt = roots().get(root)
    if not rt:
        raise DownloadError(f"Unknown destination '{root}'")
    base = os.path.realpath(rt["path"])
    full = os.path.realpath(os.path.join(base, *split_subdir(subdir), check_name(name)))
    if os.path.commonpath([base, full]) != base:
        raise DownloadError("Destination is outside of the model folder")
    return full


def display_path(path):
    try:
        rel = os.path.relpath(path, os.path.dirname(os.path.abspath(folder_paths.models_dir)))
    except ValueError:
        return path
    return path if rel.startswith("..") else rel.replace("\\", "/")


def list_subdirs(root):
    rt = roots().get(root)
    if not rt:
        raise DownloadError(f"Unknown destination '{root}'")
    base, out = rt["path"], []
    for cur, dirs, _ in os.walk(base):
        dirs[:] = sorted(d for d in dirs if not d.startswith("."))
        depth = os.path.relpath(cur, base).count(os.sep) + 1
        if cur != base:
            out.append(os.path.relpath(cur, base).replace("\\", "/"))
        if depth >= 4 or len(out) >= 500:
            dirs[:] = []
    return out


# ---------------------------------------------------------------- resolvers ---

def guess_root(path, available):
    parts = [p.lower() for p in path.split("/")]
    for part in parts[:-1]:
        hit = FOLDER_HINTS.get(part)
        if hit in available:
            return hit
    stem = parts[-1].rsplit(".", 1)[0]
    for word in re.split(r"[^a-z0-9]+", stem):
        hit = FOLDER_HINTS.get(word)
        if hit in available and hit in ("vae", "loras", "controlnet"):
            return hit
    return None


def file_entry(name, url, size, sha256, root=None, **extra):
    return {"name": name, "url": url, "size": size, "sha256": (sha256 or "").lower() or None, "root": root, **extra}


def resolve_civitai(p):
    host = re.sub(r"^www\.", "", p.hostname)
    origin = f"https://{host}"
    q = urllib.parse.parse_qs(p.query)
    model_id = version_id = None
    if m := re.search(r"/(?:model-versions|download/models)/(\d+)", p.path):
        version_id = m.group(1)
    elif m := re.search(r"/models/(\d+)", p.path):
        model_id = m.group(1)
        version_id = (q.get("modelVersionId") or [None])[0]
    else:
        raise DownloadError("Unrecognised CivitAI link. Use a model page, a model version or a download link")
    if not model_id:
        version, _ = get_json(f"{origin}/api/v1/model-versions/{version_id}")
        model_id = version["modelId"]
    model, _ = get_json(f"{origin}/api/v1/models/{model_id}")

    available = roots()
    model_root = CIVITAI_TYPES.get(model["type"])
    versions = []
    for v in model["modelVersions"]:
        files = []
        for f in v["files"]:
            fmt = " · ".join(x for x in (f.get("type"), f["metadata"].get("format"), f["metadata"].get("size"), f["metadata"].get("fp")) if x)
            kind = f.get("type")
            root = "vae" if kind == "VAE" else model_root
            url = urllib.parse.urlsplit(f["downloadUrl"])._replace(netloc=host).geturl()
            files.append(file_entry(f["name"], url, int(f["sizeKB"] * 1024), f["hashes"].get("SHA256"),
                                    root if root in available else None, detail=fmt,
                                    selected=bool(f.get("primary")), extra=kind in ("Training Data", "Archive")))
        image = next((i["url"] for i in v["images"] if i["type"] == "image" and i["nsfwLevel"] == 1), None)
        if image:
            image = re.sub(r"/(original=true|width=\d+)/", "/width=256/", image)
        versions.append({"id": v["id"], "name": v["name"], "base_model": v.get("baseModel"), "image": image, "files": files})
    selected = next((v["id"] for v in versions if str(v["id"]) == str(version_id)), versions[0]["id"]) if versions else None
    return {"source": "civitai", "title": model["name"], "subtitle": " · ".join(x for x in (model["type"], (model.get("creator") or {}).get("username")) if x),
            "page": f"{origin}/models/{model_id}", "versions": versions, "version": selected}


def hf_file_url(kind, repo, rev, path):
    prefix = "" if kind == "models" else f"{kind}/"
    return f"https://huggingface.co/{prefix}{repo}/resolve/{urllib.parse.quote(rev, safe='')}/{urllib.parse.quote(path)}"


def hf_entry(kind, repo, rev, e, available, selected=False):
    sha = (e.get("lfs") or {}).get("oid")
    path = e["path"]
    return file_entry(path.rsplit("/", 1)[-1], hf_file_url(kind, repo, rev, path), e["size"], sha, guess_root(path, available),
                      path=path, model=os.path.splitext(path)[1].lower() in MODEL_EXTS, selected=selected)


def resolve_hf(p):
    parts = [urllib.parse.unquote(s) for s in p.path.split("/") if s]
    kind = "models"
    if parts and parts[0] in ("models", "datasets", "spaces"):
        kind = parts.pop(0)
    if not parts:
        raise DownloadError("Paste a link to a repo or a file on Hugging Face")
    n = 1 if len(parts) == 1 or parts[1] in ("resolve", "blob", "tree", "raw") else 2
    repo, rest = "/".join(parts[:n]), parts[n:]
    mode = rest[0] if rest and rest[0] in ("resolve", "blob", "tree", "raw") else None
    rev = rest[1] if len(rest) > 1 else "main"
    sub = "/".join(rest[2:])
    available = roots()
    api = f"https://huggingface.co/api/{kind}/{repo}"
    erev = urllib.parse.quote(rev, safe="")

    files = None
    if mode in ("resolve", "blob", "raw") and sub:
        info, _ = get_json(f"{api}/paths-info/{erev}", method="POST", json={"paths": [sub]})
        if info and info[0]["type"] == "file":
            files = [hf_entry(kind, repo, rev, info[0], available, selected=True)]
    if files is None:
        files, url = [], f"{api}/tree/{erev}{'/' + urllib.parse.quote(sub) if sub else ''}?recursive=true&expand=false"
        while url and len(files) < 20000:
            page, url = get_json(url)
            files += [hf_entry(kind, repo, rev, e, available) for e in page if e["type"] == "file"]
        models = [f for f in files if f["model"]]
        if len(models) == 1:
            models[0]["selected"] = True
    return {"source": "huggingface", "title": repo, "subtitle": f"{kind[:-1]} · {rev}{' · ' + sub if sub else ''}",
            "page": f"https://huggingface.co/{'' if kind == 'models' else kind + '/'}{repo}", "files": files}


def filename_from_headers(r):
    cd = r.headers.get("Content-Disposition", "")
    if m := re.search(r"filename\*\s*=\s*[\w-]*'[^']*'([^;]+)", cd):
        return urllib.parse.unquote(m.group(1).strip('" '))
    if m := re.search(r'filename\s*=\s*"?([^";]+)"?', cd):
        return m.group(1).strip()
    return urllib.parse.unquote(os.path.basename(urllib.parse.urlsplit(r.url).path))


def resolve_direct(url):
    r = open_url(url, stream=True)
    with r:
        check_status(r, url)
        if r.headers.get("Content-Type", "").startswith("text/html"):
            raise DownloadError("That link is a web page, not a file. Paste a direct download link")
        name = INVALID_NAME.sub("_", filename_from_headers(r)) or "download.bin"
        size = int(r.headers.get("Content-Length") or 0) or None
    available = roots()
    return {"source": "direct", "title": name, "subtitle": urllib.parse.urlsplit(url).hostname, "page": url,
            "files": [file_entry(name, url, size, None, guess_root(name, available), selected=True)]}


def resolve(url):
    url = url.strip()
    if not re.match(r"^[a-z]+://", url, re.I):
        url = f"https://{url}"
    check_url(url)
    p = urllib.parse.urlsplit(url)
    if CIVITAI_HOST.search(p.hostname):
        return resolve_civitai(p)
    if re.sub(r"^www\.", "", p.hostname) in HF_HOSTS:
        return resolve_hf(p)
    return resolve_direct(url)


# ---------------------------------------------------------------- downloads ---

def hash_file(path, hasher):
    with open(path, "rb") as f:
        while chunk := f.read(1 << 22):
            hasher.update(chunk)


def check_safetensors(path):
    with open(path, "rb") as f:
        head = f.read(8)
        n = int.from_bytes(head, "little")
        if len(head) < 8 or n > 100 << 20 or n + 8 > os.path.getsize(path):
            raise DownloadError("The file is not a valid .safetensors (corrupt, truncated or not a model)")
        try:
            json.loads(f.read(n))
        except ValueError:
            raise DownloadError("The file is not a valid .safetensors (corrupt, truncated or not a model)")


def fmt_size(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


class Job:
    def __init__(self, url, name, root, subdir, path, size, sha256, overwrite, source):
        self.id = uuid.uuid4().hex[:12]
        self.url = url
        self.name = name
        self.root = root
        self.subdir = subdir
        self.path = path
        self.size = size
        self.sha256 = sha256
        self.overwrite = overwrite
        self.source = source
        self.done = 0
        self.speed = 0.0
        self.status = "queued"
        self.error = ""
        self.created = time.time()
        self.finished = None
        self.stop = threading.Event()
        self.reason = None
        self.emitted = 0.0

    @property
    def part(self):
        return f"{self.path}.part"

    def to_dict(self):
        eta = (self.size - self.done) / self.speed if self.speed > 1 and self.size and self.status == "downloading" else None
        return {"id": self.id, "url": self.url, "name": self.name, "root": self.root, "subdir": self.subdir, "dest": display_path(self.path),
                "size": self.size, "sha256": self.sha256, "overwrite": self.overwrite, "source": self.source, "done": self.done,
                "speed": self.speed if self.status == "downloading" else 0, "eta": eta, "status": self.status, "error": self.error,
                "created": self.created, "finished": self.finished}

    def saved(self):
        d = self.to_dict()
        for k in ("speed", "eta", "dest"):
            del d[k]
        return d


class Manager:
    def __init__(self):
        self.jobs = OrderedDict()
        self.lock = threading.RLock()

    def load(self):
        if not os.path.isfile(JOBS_FILE):
            return
        with open(JOBS_FILE, encoding="utf-8") as f:
            for d in json.load(f):
                try:
                    path = dest_path(d["root"], d["subdir"], d["name"])
                except DownloadError:
                    continue  # the model folder is no longer registered
                j = Job(d["url"], d["name"], d["root"], d["subdir"], path, d["size"], d["sha256"], d["overwrite"], d["source"])
                j.id, j.done, j.status, j.error, j.created, j.finished = d["id"], d["done"], d["status"], d["error"], d["created"], d["finished"]
                if j.status in ("queued", "downloading"):
                    j.status = "paused"
                if j.status == "paused" and os.path.isfile(j.part):
                    j.done = os.path.getsize(j.part)
                self.jobs[j.id] = j

    def save(self):
        with self.lock:
            finished = [j for j in self.jobs.values() if j.status in ("done", "failed", "cancelled", "skipped")]
            for j in finished[:-MAX_HISTORY]:
                del self.jobs[j.id]
            write_json(JOBS_FILE, [j.saved() for j in self.jobs.values()])

    def emit(self, job, force=True):
        now = time.monotonic()
        if force or now - job.emitted > 0.4:
            job.emitted = now
            PromptServer.instance.send_sync("modeldl.job", job.to_dict())

    def busy_paths(self):
        return {os.path.normcase(j.path) for j in self.jobs.values() if j.status in ("queued", "downloading", "paused")}

    def add(self, spec):
        url = spec["url"]
        check_url(url)
        name = check_name(spec["name"])
        subdir = "/".join(split_subdir(spec.get("subdir")))
        path = dest_path(spec["root"], subdir, name)
        policy = spec.get("if_exists", "rename")
        with self.lock:
            busy = self.busy_paths()
            taken = os.path.normcase(path) in busy
            skipped = False
            if taken and policy != "rename":
                raise DownloadError(f"'{name}' is already queued for that location")
            if taken or os.path.exists(path):
                if policy == "skip":
                    skipped = True
                elif policy == "rename":
                    stem, ext = os.path.splitext(path)
                    i = 1
                    while os.path.exists(f"{stem} ({i}){ext}") or os.path.normcase(f"{stem} ({i}){ext}") in busy:
                        i += 1
                    path = f"{stem} ({i}){ext}"
                    name = os.path.basename(path)
            job = Job(url, name, spec["root"], subdir, path, spec.get("size"), spec.get("sha256"), policy == "overwrite", spec.get("source", "direct"))
            if skipped:
                job.status, job.error, job.finished = "skipped", "File already exists", time.time()
            self.jobs[job.id] = job
            self.save()
            self.emit(job)
            self.pump()
            return job

    def pump(self):
        with self.lock:
            running = sum(j.status == "downloading" for j in self.jobs.values())
            for j in self.jobs.values():
                if running >= _settings["max_concurrent"]:
                    break
                if j.status == "queued":
                    j.status = "downloading"
                    j.stop.clear()
                    j.reason = None
                    running += 1
                    self.emit(j)
                    threading.Thread(target=self.run, args=(j,), name=f"modeldl-{j.id}", daemon=True).start()

    def finish(self, job, status, error=""):
        with self.lock:
            job.status, job.error, job.speed = status, error, 0
            if status in ("done", "failed", "cancelled"):
                job.finished = time.time()
            self.save()
            self.emit(job)
        self.pump()

    def run(self, job):
        attempt = 0
        while True:
            try:
                self.download(job)
                return self.finish(job, "done")
            except Stopped:
                return self.stopped(job)
            except DownloadError as e:
                return self.finish(job, "failed", str(e))
            except (requests.RequestException, Incomplete) as e:
                attempt += 1
                if attempt >= RETRIES:
                    return self.finish(job, "failed", f"Network error: {e}")
                log.warning("%s: %s, retrying (%d/%d)", job.name, e, attempt, RETRIES - 1)
                if job.stop.wait(2 ** attempt):
                    return self.stopped(job)
            except OSError as e:
                return self.finish(job, "failed", f"Disk error: {e}")

    def stopped(self, job):
        if job.reason != "cancel":
            return self.finish(job, "paused")
        self.discard_part(job)
        job.done = 0
        self.finish(job, "cancelled")

    @staticmethod
    def discard_part(job):
        if os.path.isfile(job.part):
            os.remove(job.part)

    def download(self, job):
        os.makedirs(os.path.dirname(job.path), exist_ok=True)
        have = os.path.getsize(job.part) if os.path.isfile(job.part) else 0
        r = open_url(job.url, headers={"Accept-Encoding": "identity", **({"Range": f"bytes={have}-"} if have else {})}, stream=True)
        with r:
            if r.status_code == 416:
                total = int(r.headers.get("Content-Range", "*/0").rsplit("/", 1)[-1] or 0)
                if total != have:
                    self.discard_part(job)
                    raise Incomplete("resume point rejected, restarting")
            else:
                check_status(r, job.url)
                if r.headers.get("Content-Type", "").startswith("text/html"):
                    raise DownloadError(html_error(job.url))
                if r.status_code != 206:
                    have = 0
                if r.status_code == 206:
                    tail = r.headers.get("Content-Range", "").rsplit("/", 1)[-1]
                    total = int(tail) if tail.isdigit() else 0
                else:
                    total = int(r.headers.get("Content-Length") or 0)
                total = total or job.size or 0
                job.size = total or job.size
                if total:
                    free = shutil.disk_usage(os.path.dirname(job.path)).free
                    if total - have > free:
                        raise DownloadError(f"Not enough disk space ({fmt_size(free)} free, {fmt_size(total - have)} needed)")
                hasher = hashlib.sha256() if job.sha256 else None
                if hasher and have:
                    hash_file(job.part, hasher)
                job.done = have
                t0, b0 = time.monotonic(), have
                with open(job.part, "ab" if have else "wb") as f:
                    for chunk in r.iter_content(1 << 20):
                        if job.stop.is_set():
                            raise Stopped
                        f.write(chunk)
                        if hasher:
                            hasher.update(chunk)
                        job.done += len(chunk)
                        now = time.monotonic()
                        if now - t0 >= 0.5:
                            inst = (job.done - b0) / (now - t0)
                            job.speed = inst if not job.speed else 0.6 * job.speed + 0.4 * inst
                            t0, b0 = now, job.done
                            self.emit(job, force=False)
                if total and job.done != total:
                    raise Incomplete(f"connection closed after {fmt_size(job.done)} of {fmt_size(total)}")
                if hasher and hasher.hexdigest() != job.sha256:
                    self.discard_part(job)
                    raise DownloadError("SHA256 mismatch: the downloaded file is corrupt. Try again")
        if job.name.lower().endswith(".safetensors"):
            try:
                check_safetensors(job.part)
            except DownloadError:
                self.discard_part(job)
                raise
        self.place(job)

    def place(self, job):
        path = job.path
        if os.path.exists(path) and not job.overwrite:
            stem, ext = os.path.splitext(path)
            i = 1
            while os.path.exists(f"{stem} ({i}){ext}"):
                i += 1
            path = job.path = f"{stem} ({i}){ext}"
            job.name = os.path.basename(path)
        os.replace(job.part, path)
        job.done = os.path.getsize(path)
        job.size = job.size or job.done

    def act(self, job_id, action):
        with self.lock:
            job = self.jobs.get(job_id)
            if not job:
                raise DownloadError("Unknown download")
            live = job.status == "downloading"
            if action == "pause" and job.status in ("queued", "downloading"):
                if live:
                    job.reason = "pause"
                    job.stop.set()
                else:
                    self.finish(job, "paused")
            elif action == "resume" and job.status == "paused":
                self.finish(job, "queued")
            elif action == "cancel" and job.status in ("queued", "downloading", "paused"):
                if live:
                    job.reason = "cancel"
                    job.stop.set()
                else:
                    self.discard_part(job)
                    job.done = 0
                    self.finish(job, "cancelled")
            elif action == "retry" and job.status in ("failed", "cancelled", "skipped"):
                if os.path.normcase(job.path) in self.busy_paths():
                    raise DownloadError("That file is already queued")
                job.overwrite = job.overwrite or job.status == "skipped"
                self.finish(job, "queued")
            elif action == "remove" and not live:
                if job.status in ("failed", "queued", "paused"):
                    self.discard_part(job)
                del self.jobs[job.id]
                self.save()
                PromptServer.instance.send_sync("modeldl.removed", {"id": job.id})
            else:
                raise DownloadError(f"Can't {action} a download that is {job.status}")

    def clear_finished(self):
        with self.lock:
            for j in [j for j in self.jobs.values() if j.status in ("done", "cancelled", "skipped")]:
                del self.jobs[j.id]
                PromptServer.instance.send_sync("modeldl.removed", {"id": j.id})
            self.save()


load_settings()
manager = Manager()
manager.load()


# ------------------------------------------------------------------ routes ---

async def read_json(request):
    try:
        return await request.json()
    except json.JSONDecodeError:
        raise web.HTTPBadRequest(text="Invalid JSON")


def error_response(e):
    if isinstance(e, DownloadError):
        raise web.HTTPBadRequest(text=str(e))
    if isinstance(e, requests.RequestException):
        raise web.HTTPBadGateway(text=f"Request failed: {e}")
    if isinstance(e, (KeyError, TypeError, ValueError)):
        raise web.HTTPBadRequest(text=f"Bad request: {e!r}")
    raise web.HTTPInternalServerError(text=str(e))


@routes.get("/modeldl/roots")
async def roots_route(request):
    return web.json_response([{"id": k, "label": v["label"], "path": display_path(v["path"])} for k, v in roots().items()])


@routes.get("/modeldl/dirs")
async def dirs_route(request):
    try:
        return web.json_response(await asyncio.to_thread(list_subdirs, request.query.get("root", "")))
    except Exception as e:
        error_response(e)


@routes.post("/modeldl/resolve")
async def resolve_route(request):
    try:
        return web.json_response(await asyncio.to_thread(resolve, (await read_json(request))["url"]))
    except Exception as e:
        error_response(e)


@routes.post("/modeldl/exists")
async def exists_route(request):
    try:
        return web.json_response([os.path.exists(dest_path(i["root"], i.get("subdir"), i["name"])) for i in (await read_json(request))["items"]])
    except Exception as e:
        error_response(e)


@routes.post("/modeldl/queue")
async def queue_route(request):
    jobs, errors = [], []
    for spec in (await read_json(request))["items"]:
        try:
            jobs.append((await asyncio.to_thread(manager.add, spec)).to_dict())
        except DownloadError as e:
            errors.append({"name": spec.get("name"), "error": str(e)})
        except Exception as e:
            error_response(e)
    return web.json_response({"jobs": jobs, "errors": errors})


@routes.get("/modeldl/list")
async def list_route(request):
    with manager.lock:
        return web.json_response([j.to_dict() for j in manager.jobs.values()])


@routes.post("/modeldl/action")
async def action_route(request):
    body = await read_json(request)
    try:
        if body["action"] == "clear_finished":
            manager.clear_finished()
        elif body["action"] == "resume_all":
            for j in [j for j in manager.jobs.values() if j.status == "paused"]:
                manager.act(j.id, "resume")
        else:
            manager.act(body["id"], body["action"])
    except Exception as e:
        error_response(e)
    return web.json_response({})


@routes.get("/modeldl/settings")
async def get_settings_route(request):
    return web.json_response(public_settings())


@routes.post("/modeldl/settings")
async def set_settings_route(request):
    body = await read_json(request)
    with _settings_lock:
        for key in ("civitai_key", "hf_token"):
            if isinstance(body.get(key), str):
                _settings[key] = body[key].strip()
        if "max_concurrent" in body:
            _settings["max_concurrent"] = max(1, min(8, int(body["max_concurrent"])))
        if "allow_local" in body:
            _settings["allow_local"] = bool(body["allow_local"])
        write_json(SETTINGS_FILE, _settings)
        try:
            os.chmod(SETTINGS_FILE, 0o600)
        except OSError:
            pass
    manager.pump()
    return web.json_response(public_settings())


def test_token(which):
    if which == "hf":
        data, _ = get_json("https://huggingface.co/api/whoami-v2")
        return f"Signed in to Hugging Face as {data['name']}"
    get_json("https://civitai.com/api/v1/models?favorites=true&limit=1")
    return "CivitAI accepted the API key"


@routes.post("/modeldl/test")
async def test_route(request):
    which = (await read_json(request)).get("which")
    try:
        return web.json_response({"message": await asyncio.to_thread(test_token, which)})
    except Exception as e:
        error_response(e)
