// 展示形式的注册表。
//
// 加一种新形式：在本目录写一个模块，导出 { id, label, create(model) }，
// create 返回 { query(x0, y0, x1, y1, cell, cb) }，再在下面登记一行即可。
// 画布、加载调度、大图、设置面板都不需要改：它们只认 query 吐出的矩形和图片下标。
//
// 约束：query 必须是纯的（同一 model、同一矩形 → 同样的块、同样的 key、同样的图），
// 否则拖回来图会变。

import { collage } from './collage.js';
import { justified } from './justified.js';
import { grid } from './grid.js';
import { mosaic } from './mosaic.js';

// 顺序就是设置面板里的顺序。mosaic 是有边界的（一幅画），其他是无限的
export const LAYOUTS = [collage, justified, grid, mosaic];

export function getLayout(id) {
  return LAYOUTS.find((l) => l.id === id) || LAYOUTS[0];
}

export { buildModel } from './model.js';
