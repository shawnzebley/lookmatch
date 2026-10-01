"""Deep Preset as a Hugging Face Space, for LookMatch's "model assist".

POST /gradio_api/call/stylize  {"data": [<photo jpeg as base64>, <reference jpeg as base64>]}
returns the photo restyled to match the reference, as base64 JPEG (same size as the photo).

Deep Preset (github.com/minhmanho/deep_preset) is non-commercial. Weights are the wPPL checkpoint
from its README. Runs on ZeroGPU when the Space has it, CPU otherwise (about 2.5 s at 512 px)."""
import base64, io, os, subprocess, sys

import gradio as gr
import numpy as np
import torch
from PIL import Image

try:
    import spaces
    gpu = spaces.GPU
except ImportError:
    gpu = lambda f: f

REPO = os.path.join(os.path.dirname(__file__), 'deep_preset')
CKPT = os.path.join(os.path.dirname(__file__), 'dp_wppl.pth.tar')
GDRIVE_ID = '1GegyHf3OD17k_WID3-vA7S8nRQwPfpTC'   # "Deep Preset with PPL", from the repo README

if not os.path.isdir(REPO):
    subprocess.check_call(['git', 'clone', '--depth', '1', 'https://github.com/minhmanho/deep_preset', REPO])
if not os.path.isfile(CKPT):
    import gdown
    gdown.download(id=GDRIVE_ID, output=CKPT, quiet=False)

sys.path.insert(0, REPO)
from networks.network import get_model  # noqa: E402

ckpt = torch.load(CKPT, map_location='cpu', weights_only=False)
G = get_model(ckpt['opts'].g_net)(ckpt['opts'])
G.load_state_dict(ckpt['G'])
G.eval()
torch.set_grad_enabled(False)

MAX_SIDE = 640   # the app sends 512; refuse anything much bigger so a stray call can't eat the GPU quota


def decode(b64):
    if ',' in b64[:64]:
        b64 = b64.split(',', 1)[1]
    return Image.open(io.BytesIO(base64.b64decode(b64))).convert('RGB')


def tensor(im):
    return torch.from_numpy(((np.asarray(im, dtype=np.float32) / 255) - 0.5) / 0.5).permute(2, 0, 1)[None]


@gpu
@torch.no_grad()   # grad mode is per-thread, and ZeroGPU runs this off the main thread
def run(photo, ref):
    dev = 'cuda' if torch.cuda.is_available() else 'cpu'
    G.to(dev)
    W, H = photo.size
    size = (max(16, round(W / 16) * 16), max(16, round(H / 16) * 16))   # the net needs multiples of 16
    t = tensor(photo.resize(size, Image.BICUBIC)).to(dev)
    c = tensor(ref.resize(size, Image.BICUBIC)).to(dev)
    out, _, _ = G.stylize(t, c, False)
    o = ((out[0].clamp(-1, 1) + 1) / 2).permute(1, 2, 0).cpu().numpy()
    return Image.fromarray((o * 255 + 0.5).astype(np.uint8)).resize((W, H), Image.BICUBIC)


def stylize(photo_b64, ref_b64):
    photo, ref = decode(photo_b64), decode(ref_b64)
    if max(photo.size) > MAX_SIDE:
        raise gr.Error(f'Photo is {photo.size[0]}x{photo.size[1]}; send {MAX_SIDE} px or less on the long side.')
    if max(ref.size) > 2 * MAX_SIDE:
        ref.thumbnail((MAX_SIDE, MAX_SIDE))
    buf = io.BytesIO()
    run(photo, ref).save(buf, 'JPEG', quality=92)
    return base64.b64encode(buf.getvalue()).decode()


demo = gr.Interface(stylize, [gr.Textbox(label='photo (base64 jpeg)'), gr.Textbox(label='reference (base64 jpeg)')],
                    gr.Textbox(label='result (base64 jpeg)'), api_name='stylize', flagging_mode='never',
                    title='LookMatch: Deep Preset')
demo.queue(max_size=8).launch()
