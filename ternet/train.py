#!/usr/bin/env python3
"""ternet/train.py — réseau de neurones ENTIÈREMENT ternaire pour TRI-27.

Données : sklearn `load_digits` (UCI Optical Recognition of Handwritten Digits, 1797
images 8x8, niveaux 0..16), découpage fixe 75/25 stratifié (graine 0).

Modèle (tout en trits, inférence en entiers exacts) :
  x  = 64 pixels ternarisés  (-1 fond, 0 gris, +1 encre)       -> 3 mots de 27 trits
  h  = H neurones cachés ternaires : h_j = +1 si W1_j·x > tp_j, -1 si < tn_j, 0 sinon
  y  = argmax_k (W2_k·h + c_k)                                  (W1, W2 dans {-1,0,+1})
Chaque W·x est une somme de TDOT (27 produits en une instruction).

Entraînement : quantization-aware (TWN : seuil 0.7·mean|W|, estimateur straight-through),
Adam, numpy pur. La référence entière `infer_int` est LE modèle livré : c'est elle qui
est comparée bit à bit à l'inférence sur la VM.

Sortie : cc/examples/ternet_model.h (poids empaquetés + jeu de test + prédictions hôte).
"""
import argparse, json, sys
from pathlib import Path
import numpy as np
from sklearn.datasets import load_digits
from sklearn.model_selection import train_test_split

ROOT = Path(__file__).resolve().parent.parent

def augment(X, y):
    """Décalages horizontaux dx = -1/+1 (fond = 0) : robustesse à la position du tracé."""
    im = X.reshape(-1, 8, 8); out = [X]; ys = [y]
    for dx in (1, -1):
        sh = np.zeros_like(im)
        if dx == 1: sh[:, :, 1:] = im[:, :, :-1]
        else: sh[:, :, :-1] = im[:, :, 1:]
        out.append(sh.reshape(-1, 64)); ys.append(y)
    return np.concatenate(out), np.concatenate(ys)

def ternarize_input(X):
    return np.where(X <= 3, -1, np.where(X >= 10, 1, 0)).astype(np.int64)

def tw_quant(W):
    d = 0.7 * np.mean(np.abs(W), axis=1, keepdims=True)
    q = np.sign(W) * (np.abs(W) > d)
    nz = np.maximum((q != 0).sum(axis=1, keepdims=True), 1)
    a = (np.abs(W) * (q != 0)).sum(axis=1, keepdims=True) / nz
    return q.astype(np.float64), a

def train(H, epochs, seed, Xtr, ytr):
    rng = np.random.default_rng(seed)
    W1 = rng.normal(0, 0.3, (H, 64)); b1 = np.zeros(H)
    W2 = rng.normal(0, 0.3, (10, H)); b2 = np.zeros(10)
    params = [W1, b1, W2, b2]
    m = [np.zeros_like(p) for p in params]; v = [np.zeros_like(p) for p in params]
    lr, t, B = 0.01, 0, 64
    Y = np.eye(10)[ytr]
    for ep in range(epochs):
        idx = rng.permutation(len(Xtr))
        for s in range(0, len(idx), B):
            bi = idx[s:s + B]; x = Xtr[bi].astype(np.float64); y = Y[bi]
            q1, a1 = tw_quant(W1); q2, a2 = tw_quant(W2)
            z1 = x @ (q1 * a1).T + b1                       # pré-activation
            hs = np.clip(z1, -1.5, 1.5)
            h = np.round(np.clip(z1, -1, 1))                # ternaire (seuils ±0.5)
            z2 = h @ (q2 * a2).T + b2
            z2 -= z2.max(1, keepdims=True); p = np.exp(z2); p /= p.sum(1, keepdims=True)
            g2 = (p - y) / len(bi)
            gW2 = g2.T @ h; gb2 = g2.sum(0)
            gh = g2 @ (q2 * a2)
            gz1 = gh * (np.abs(z1) <= 1.5)                  # STE
            gW1 = gz1.T @ x; gb1 = gz1.sum(0)
            t += 1
            for i, (pp, gg) in enumerate(zip(params, [gW1, gb1, gW2, gb2])):
                m[i] = 0.9 * m[i] + 0.1 * gg; v[i] = 0.999 * v[i] + 0.001 * gg * gg
                pp -= lr * (m[i] / (1 - 0.9 ** t)) / (np.sqrt(v[i] / (1 - 0.999 ** t)) + 1e-8)
        if ep == int(epochs * 0.7): lr *= 0.3
    return W1, b1, W2, b2

def export_int(W1, b1, W2, b2):
    """Modèle entier exact : poids ternaires, seuils et biais entiers."""
    q1, a1 = tw_quant(W1); q2, a2 = tw_quant(W2)
    a1 = a1[:, 0]; a2 = a2[:, 0]
    # h=+1 si a1*s + b1 > 0.5  <=>  s > (0.5-b1)/a1 ; s entier -> tp = floor((0.5-b1)/a1)
    tp = np.floor((0.5 - b1) / a1).astype(np.int64)
    # h=-1 si a1*s + b1 < -0.5 <=>  s < (-0.5-b1)/a1 ; tn = ceil(...)
    tn = np.ceil((-0.5 - b1) / a1).astype(np.int64)
    # score_k = a2_k*(W2_k·h) + b2_k : échelle par classe -> on garde une échelle entière commune
    S = 64
    w2s = np.round(a2 * S).astype(np.int64)           # échelle par classe, entière
    c = np.round(b2 * S).astype(np.int64)
    return q1.astype(np.int64), tp, tn, q2.astype(np.int64), w2s, c

def infer_int(Xt, q1, tp, tn, q2, w2s, c):
    s1 = Xt @ q1.T
    h = np.where(s1 > tp, 1, np.where(s1 < tn, -1, 0))
    sc = (h @ q2.T) * w2s + c
    return sc.argmax(1), h

def pack(trits):
    """liste de trits (t0 poids faible) -> valeurs de mots de 27 trits."""
    trits = list(trits) + [0] * ((-len(trits)) % 27)
    words = []
    for k in range(0, len(trits), 27):
        v = 0
        for t in reversed(trits[k:k + 27]): v = v * 3 + int(t)
        words.append(v)
    return words

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--hidden', type=int, default=54)
    ap.add_argument('--epochs', type=int, default=150)
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--augment', action='store_true', help='décalages ±1 px à l\'entraînement')
    ap.add_argument('--out', default=str(ROOT / 'cc/examples/ternet_model.h'))
    a = ap.parse_args()
    d = load_digits()
    Xtr, Xte, ytr, yte = train_test_split(d.data, d.target, test_size=0.25, random_state=0, stratify=d.target)
    Ttr, Tte = ternarize_input(Xtr), ternarize_input(Xte)
    Xa, ya = augment(Xtr, ytr) if a.augment else (Xtr, ytr)
    W1, b1, W2, b2 = train(a.hidden, a.epochs, a.seed, ternarize_input(Xa), ya)
    q1, tp, tn, q2, w2s, c = export_int(W1, b1, W2, b2)
    ptr, _ = infer_int(Ttr, q1, tp, tn, q2, w2s, c)
    pte, hte = infer_int(Tte, q1, tp, tn, q2, w2s, c)
    acc_tr, acc_te = (ptr == ytr).mean(), (pte == yte).mean()
    zeros = float((q1 == 0).mean()), float((q2 == 0).mean())
    hz = float((hte == 0).mean())
    print(f'H={a.hidden} : précision entière train {acc_tr:.4f}  test {acc_te:.4f}  '
          f'(poids nuls W1 {zeros[0]:.0%} W2 {zeros[1]:.0%}, cachés à 0 sur test {hz:.0%})')
    HW = (a.hidden + 26) // 27
    L = []
    L.append('/* GÉNÉRÉ par ternet/train.py — ne pas éditer. */')
    L.append(f'/* load_digits, test 25 % stratifié graine 0 ; H={a.hidden}, epochs={a.epochs}, seed={a.seed}, augmentation={a.augment} */')
    L.append(f'/* précision (référence entière hôte) : train {acc_tr:.4f}, test {acc_te:.4f} */')
    L.append(f'#define TN_H {a.hidden}\n#define TN_HW {HW}\n#define TN_NTEST {len(yte)}')
    L.append('static const long TN_W1[TN_H][3] = {' + ','.join('{' + ','.join(map(str, pack(r))) + '}' for r in q1) + '};')
    L.append('static const long TN_TP[TN_H] = {' + ','.join(map(str, tp)) + '};')
    L.append('static const long TN_TN[TN_H] = {' + ','.join(map(str, tn)) + '};')
    L.append('static const long TN_W2[10][TN_HW] = {' + ','.join('{' + ','.join(map(str, pack(r))) + '}' for r in q2) + '};')
    L.append('static const long TN_S[10] = {' + ','.join(map(str, w2s)) + '};')
    L.append('static const long TN_C[10] = {' + ','.join(map(str, c)) + '};')
    L.append('static const long TN_X[TN_NTEST][3] = {' + ','.join('{' + ','.join(map(str, pack(r))) + '}' for r in Tte) + '};')
    L.append('static const char TN_Y[TN_NTEST] = {' + ','.join(map(str, yte)) + '};')
    L.append('static const char TN_HOST[TN_NTEST] = {' + ','.join(map(str, pte)) + '};')
    Path(a.out).write_text('\n'.join(L) + '\n', encoding='utf-8')
    print('écrit', a.out)

if __name__ == '__main__':
    main()
