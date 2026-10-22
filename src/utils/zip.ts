import type { Writable } from 'node:stream';

/**
 * A ZIP archive, written straight to a stream: the year-end package for the
 * accountant, a few CSVs and every receipt. Entries are stored, not
 * compressed (receipts are JPEGs and PDFs, which do not shrink), so this is
 * the format's simplest form and needs no library. One entry is held in
 * memory at a time; nothing is buffered beyond that.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS date and time, which is what ZIP stores. */
function dosDateTime(when: Date): { date: number; time: number } {
  const year = Math.max(1980, when.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2),
  };
}

interface Entry {
  name: Buffer;
  crc: number;
  size: number;
  offset: number;
  date: number;
  time: number;
}

/** Bit 11: the file name is UTF-8. */
const UTF8 = 0x0800;

export class ZipWriter {
  private offset = 0;
  private readonly entries: Entry[] = [];

  constructor(private readonly out: Writable) {}

  private async write(chunk: Buffer): Promise<void> {
    this.offset += chunk.length;
    if (!this.out.write(chunk)) {
      await new Promise<void>((resolve, reject) => {
        const done = (err?: Error) => {
          this.out.off('drain', done);
          this.out.off('error', done);
          if (err) reject(err);
          else resolve();
        };
        this.out.once('drain', done);
        this.out.once('error', done);
      });
    }
  }

  async add(name: string, data: Buffer, when: Date = new Date()): Promise<void> {
    const nameBytes = Buffer.from(name, 'utf8');
    const { date, time } = dosDateTime(when);
    const entry: Entry = { name: nameBytes, crc: crc32(data), size: data.length, offset: this.offset, date, time };

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(UTF8, 6);
    header.writeUInt16LE(0, 8); // stored
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(entry.crc, 14);
    header.writeUInt32LE(entry.size, 18);
    header.writeUInt32LE(entry.size, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);

    await this.write(header);
    await this.write(nameBytes);
    await this.write(data);
    this.entries.push(entry);
  }

  /** Writes the central directory. The stream is left open for the caller to end. */
  async finish(): Promise<void> {
    const start = this.offset;
    for (const e of this.entries) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(20, 4); // version made by
      header.writeUInt16LE(20, 6); // version needed
      header.writeUInt16LE(UTF8, 8);
      header.writeUInt16LE(0, 10);
      header.writeUInt16LE(e.time, 12);
      header.writeUInt16LE(e.date, 14);
      header.writeUInt32LE(e.crc, 16);
      header.writeUInt32LE(e.size, 20);
      header.writeUInt32LE(e.size, 24);
      header.writeUInt16LE(e.name.length, 28);
      header.writeUInt16LE(0, 30); // extra
      header.writeUInt16LE(0, 32); // comment
      header.writeUInt16LE(0, 34); // disk
      header.writeUInt16LE(0, 36); // internal attributes
      header.writeUInt32LE(0, 38); // external attributes
      header.writeUInt32LE(e.offset, 42);
      await this.write(header);
      await this.write(e.name);
    }
    const size = this.offset - start;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(size, 12);
    end.writeUInt32LE(start, 16);
    end.writeUInt16LE(0, 20);
    await this.write(end);
  }
}
