/** 原 image 是兼容封面；新增 images 有序保存全部产品图，首张为封面，旧单图不批量改写。 */
export const MAX_PRODUCT_IMAGES=20;
export function productImages(product:{image?:string;images?:string[]}):string[]{
 return product.images!==undefined?[...product.images]:product.image?[product.image]:[];
}
