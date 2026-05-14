import { writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import themeTemplate from '../nodeget-theme.json' with { type: 'json' }
import pkg from '../package.json' with { type: 'json' }

themeTemplate.version = pkg.version

// 项目根目录
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// 输出 JSON 配置路径
const themeJsonPath = resolve(projectRoot, 'dist/nodeget-theme.json')

// 写入主题 JSON 文件
writeFileSync(themeJsonPath, JSON.stringify(themeTemplate, null, 2) + '\n', 'utf-8')