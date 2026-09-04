// Node >= 24 removed buffer.SlowBuffer; jsonwebtoken -> buffer-equal-constant-time
// still reads it at require time. Require this file first in every test under this dir.
// ponytail: drop when jsonwebtoken drops buffer-equal-constant-time.
const b = require("buffer");
if (!b.SlowBuffer) b.SlowBuffer = b.Buffer;
