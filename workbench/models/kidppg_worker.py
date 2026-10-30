"""KID-PPG worker. Runs inside workbench/.venv-kidppg only (GPL-3.0: desktop comparison, never shipped).

stdin: the workbench pack format (engines.pack) with streams 'ppg' (n, 1) and 'acc' (n, 3), both already
on one 32 Hz grid; header {fs}. stdout: JSON {t: [...], bpm: [...], std: [...]} with t in seconds from
the first sample (centre of each 8 s window).

Steps follow the package's demo (PPG-DaLiA): 8 s windows every 2 s, per-window z-score of PPG and ACC,
the adaptive linear filter (ACC predicts the motion part of the PPG, trained per call), back to the PPG's
own scale, pairs [x(n), x(n+1)], then the probabilistic network (mean and standard deviation of HR).
The network sees absolute amplitude: it was trained on Empatica E4 BVP, whose 8 s windows have a standard
deviation of about 30 (the demo's mean is 29.6). So the PPG is band-passed 0.5 to 4 Hz and scaled so its
median window standard deviation is 30. That scaling is this workbench's choice, not the authors'.
  --selftest   runs the package's own demo recording (PPG-DaLiA S6 stairs) against its labels.
"""
import json
import os
import sys

os.environ.setdefault('TF_USE_LEGACY_KERAS', '1')      # the model is Keras 2 code; TF 2.21 ships Keras 3
os.environ.setdefault('TF_CPP_MIN_LOG_LEVEL', '2')
os.environ.setdefault('CUDA_VISIBLE_DEVICES', '-1')     # native Windows TF has no GPU after 2.10

import numpy as np

FS, WIN, STEP = 32, 256, 64
EPOCHS = int(os.environ.get('KIDPPG_EPOCHS', '500'))    # the package default for AdaptiveFilteringModel


def read_pack(buf):
    nl = buf.index(b'\n')
    head = json.loads(buf[:nl])
    o, out = nl + 1, {}
    for s in head['streams']:
        t = np.frombuffer(buf, '<f8', s['n'], o); o += s['n'] * 8
        v = np.frombuffer(buf, '<f4', s['n'] * s['ch'], o).reshape(s['n'], s['ch']); o += s['n'] * s['ch'] * 4
        out[s['key']] = (t, v.astype(np.float64))
    return head, out


def windows(ppg, acc):
    n = (len(ppg) - WIN) // STEP + 1
    X = np.zeros((max(n, 0), 4, WIN))
    for i in range(max(n, 0)):
        a = i * STEP
        X[i, 0] = ppg[a:a + WIN]
        X[i, 1:] = acc[a:a + WIN].T
    return X


E4_STD = 30.0


def prepare(ppg, acc):
    """Band-pass 0.5 to 4 Hz (4th order Butterworth, both ways) and put the PPG on the E4 BVP scale."""
    from scipy.signal import butter, filtfilt
    b, a = butter(4, [0.5, 4], btype='band', fs=FS)
    ppg = filtfilt(b, a, ppg)
    acc = filtfilt(b, a, acc, axis=0)
    n = (len(ppg) - WIN) // STEP + 1
    sd = np.median([ppg[i * STEP:i * STEP + WIN].std() for i in range(n)]) if n > 0 else ppg.std()
    return ppg * (E4_STD / (sd or 1)), acc


def infer(X):
    import tensorflow as tf
    import tf_keras
    sys.modules['keras'] = tf_keras    # adaptive_linear_model.py does `import keras`; it was written for Keras 2 (TF 2.13)
    from kid_ppg.kid_ppg import KID_PPG
    from kid_ppg.adaptive_linear_model import AdaptiveFilteringModel
    from kid_ppg.preprocessing import sample_wise_z_score_normalization, create_temporal_pairs

    Xn, ms, sds = sample_wise_z_score_normalization(X.copy())
    opt = tf.keras.optimizers.SGD(learning_rate=1e-7, momentum=1e-2)
    filt = AdaptiveFilteringModel(local_optimizer=opt, num_epochs_self_train=EPOCHS)
    xf = np.array(filt(Xn[..., None]))                  # (N, 256): PPG minus the ACC-predicted part, z units
    xf = xf * sds[:, :1] + ms[:, :1]                     # back to the PPG's own scale: the network needs it
    pairs, _ = create_temporal_pairs(xf, np.zeros(len(xf)))
    m, s = KID_PPG().predict(pairs)
    return np.asarray(m).ravel(), np.asarray(s).ravel()


def main():
    out = sys.stdout
    sys.stdout = sys.stderr     # Keras prints progress bars on stdout; only the answer goes there
    if '--selftest' in sys.argv:
        from kid_ppg.demo.demo_utils import load_demo_data
        X, y = load_demo_data()
        m, s = infer(np.asarray(X, float))
        y = np.asarray(y).ravel()[1:]
        print(json.dumps({'windows': int(len(m)), 'mae_vs_labels': float(np.mean(np.abs(m - y))), 'mean_std': float(np.mean(s))}), file=out)
        return
    head, st = read_pack(sys.stdin.buffer.read())
    ppg, acc = prepare(st['ppg'][1][:, 0], st['acc'][1])
    X = windows(ppg, acc)
    if len(X) < 2:
        print(json.dumps({'t': [], 'bpm': [], 'std': []}), file=out)
        return
    m, s = infer(X)
    # pair j predicts window j + 1; a window's HR belongs to its centre
    t = (np.arange(len(m)) + 1) * STEP / FS + WIN / FS / 2
    print(json.dumps({'t': t.tolist(), 'bpm': m.tolist(), 'std': s.tolist()}), file=out)


if __name__ == '__main__':
    main()
