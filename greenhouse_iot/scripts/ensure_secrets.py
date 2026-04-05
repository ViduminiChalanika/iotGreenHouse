# Copy include/secrets.h.example -> include/secrets.h if missing.
Import("env")

from pathlib import Path
import shutil

root = Path(env["PROJECT_DIR"])
src = root / "include" / "secrets.h.example"
dst = root / "include" / "secrets.h"
if src.exists() and not dst.exists():
    shutil.copy(src, dst)
    print("Created include/secrets.h from secrets.h.example — edit with your credentials.")
