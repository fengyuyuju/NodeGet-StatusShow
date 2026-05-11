import fs from 'fs';
import { writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ZipArchive } from 'archiver';
import pkg from "../package.json" with { type: 'json' };

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const zipFilename = `NodeGet-StatusShow-v${pkg.version}.zip`
const out = resolve(root, zipFilename)
const distOut = resolve(root, 'dist/' + zipFilename)
const output = fs.createWriteStream(out);

const archive = new ZipArchive({
    zlib: { level: 9 } // 压缩等级
});

output.on('close', () => {
    console.log(`压缩完成，总共 ${archive.pointer()} 字节`);
    fs.renameSync(out, distOut)
});

archive.on('error', err => {
    throw err;
});

archive.pipe(output);

// 添加整个文件夹
archive.directory('dist/', false);

// 完成压缩
archive.finalize();