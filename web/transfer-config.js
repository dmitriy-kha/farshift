// Sizes are in bytes. Both devices must use the same packet size.
export const CHUNK = 16 * 1024;                 // Payload per channel packet.
export const TRANSFER_WINDOW = 16 * 1024 * 1024; // Maximum unacknowledged payload.
export const WRITE_BATCH = 1024 * 1024;          // File read/write and worker batch.
export const ACK_BYTES = 256 * 1024;             // Consumed bytes between acknowledgements.
export const CHANNEL_HIGH_WATER = 1024 * 1024;   // Pause sending above this buffer size.
export const CHANNEL_LOW_WATER = 256 * 1024;     // Resume when the buffer falls to this size.
export const WRITE_DELAY = 16;                  // Maximum batch accumulation time in milliseconds.

// Batches and acknowledgements must align with packets and fit inside the window.
// Worker batches must also be multiples of 16 KiB for existing workers.
if (![CHUNK, TRANSFER_WINDOW, WRITE_BATCH, ACK_BYTES, CHANNEL_HIGH_WATER, CHANNEL_LOW_WATER]
  .every(value => Number.isSafeInteger(value) && value > 0)
  || CHUNK > 16 * 1024 || WRITE_BATCH % CHUNK || WRITE_BATCH % (16 * 1024)
  || ACK_BYTES % CHUNK || TRANSFER_WINDOW % CHUNK
  || WRITE_BATCH > TRANSFER_WINDOW || ACK_BYTES > TRANSFER_WINDOW
  || CHANNEL_LOW_WATER >= CHANNEL_HIGH_WATER) throw Error('Invalid transfer sizes');
