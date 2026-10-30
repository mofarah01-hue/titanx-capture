"""BeliefPPG worker (MIT, Bieri et al. UAI 2023). Runs inside workbench/.venv-beliefppg only.

stdin: the workbench pack format (engines.pack) with 'ppg' (n, 1) and 'acc' (n, 3) on one 64 Hz grid.
stdout: JSON {t, bpm, std} with t in seconds from the first sample.

beliefppg.infer_hr_uncertainty does its own filtering (0.1 to 18 Hz), spectra and session-wide
normalisation, so the input is the plain fused PPG and ACC. Online belief propagation ('sumproduct'),
uncertainty as the standard deviation of the HR belief in bpm, CPU only.
Times: the package returns window index * 2 s. Its training labels are offset by n_frames - 1 windows
(datasets/pipeline_generator.py prepare_session_labels), and a label is the HR of an 8 s window, so
prediction i belongs to the centre of window i + n_frames - 1: (i + n_frames - 1) * 2 + 4 s.
"""
import json
import os
import sys

os.environ.setdefault('TF_USE_LEGACY_KERAS', '1')
os.environ.setdefault('TF_CPP_MIN_LOG_LEVEL', '2')
os.environ.setdefault('CUDA_VISIBLE_DEVICES', '-1')
os.environ.setdefault('WANDB_MODE', 'disabled')     # only its training code imports wandb; make sure nothing reports out

import numpy as np

FS = 64


def read_pack(buf):
    nl = buf.index(b'\n')
    head = json.loads(buf[:nl])
    o, out = nl + 1, {}
    for s in head['streams']:
        t = np.frombuffer(buf, '<f8', s['n'], o); o += s['n'] * 8
        v = np.frombuffer(buf, '<f4', s['n'] * s['ch'], o).reshape(s['n'], s['ch']); o += s['n'] * s['ch'] * 4
        out[s['key']] = (t, v.astype(np.float64))
    return head, out


def main():
    out = sys.stdout
    sys.stdout = sys.stderr    # Keras progress bars go to stderr; only the answer goes to stdout
    from beliefppg import infer_hr_uncertainty
    from beliefppg.inference.inference import InputConfig
    from beliefppg.model.load import load_inference_model

    head, st = read_pack(sys.stdin.buffer.read())
    ppg, acc = st['ppg'][1], st['acc'][1]
    if len(ppg) < 22 * FS:
        print(json.dumps({'t': [], 'bpm': [], 'std': [], 'why': 'needs at least 22 s'}), file=out)
        return
    m = load_inference_model(os.path.join(os.path.dirname(__import__('beliefppg.inference.inference', fromlist=['x']).__file__), 'inference_model'))
    n_frames = m.input_spec[0].shape[1]
    hr, unc, _ = infer_hr_uncertainty(ppg, FS, acc, FS, decoding='sumproduct', uncertainty='std', use_gpu=False)
    hr, unc = np.asarray(hr).ravel(), np.asarray(unc).ravel()
    t = (np.arange(len(hr)) + n_frames - 1) * InputConfig.STRIDE + InputConfig.WINSIZE / 2
    print(json.dumps({'t': t.tolist(), 'bpm': hr.tolist(), 'std': unc.tolist(), 'n_frames': int(n_frames)}), file=out)


if __name__ == '__main__':
    main()
