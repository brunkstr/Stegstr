"""Why does 'smooth' fail even at high delta with repeat=5? Check if repeat copies
land in the same 8x8 block (correlated failure) instead of spread across the image."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from dct_variants import _coeff_stream, QIM_REPEAT
import numpy as np

# Simulate a Y shape similar to our covers (768x768 -> 96x96 blocks)
Y = np.zeros((96, 96, 8, 8))
stream = _coeff_stream(Y)
# repeat=5 consecutive bits -> which blocks do 5 consecutive stream entries span?
for start in [0, 24, 48, 100000]:
    positions = stream[start:start+5]
    blocks = set((by, bx) for by, bx, zi in positions)
    print(f"stream[{start}:{start+5}] -> blocks touched: {blocks}")
