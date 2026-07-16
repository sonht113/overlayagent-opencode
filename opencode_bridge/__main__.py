"""python -m opencode_bridge [daemon|run|enable|disable|status]"""

import sys

from .daemon import main

# Ensure Tool root is importable when run as script path edge cases
if __name__ == "__main__":
    sys.exit(main())
