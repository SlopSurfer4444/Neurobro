import { types } from "node:util";
/** Host-held pixels only. No URL or path authority crosses this interface. */
export type StandingVisualInput = Readonly<{mimeType:"image/png"|"image/jpeg";bytes:Buffer}>;
export const STANDING_VISUAL_BYTES=8*1024*1024;
export function snapshotStandingVisualInputs(images?:readonly StandingVisualInput[]):readonly Readonly<{mimeType:string;base64:string}>[]|undefined {
  const refuse=():never=>{throw new Error("STANDING_VISUAL_INPUT_REFUSED");};
  if(images===undefined)return undefined;
  if(types.isProxy(images)||!Array.isArray(images)||images.length<1||images.length>2||Reflect.ownKeys(images).length!==images.length+1)return refuse();
  let total=0;const output=[];
  for(let index=0;index<images.length;index++){
    const slot=Object.getOwnPropertyDescriptor(images,String(index));
    if(!slot||!("value" in slot))return refuse();
    const image=slot.value;
    if(!image||typeof image!=="object"||types.isProxy(image)||Object.getPrototypeOf(image)!==Object.prototype||Reflect.ownKeys(image).length!==2)return refuse();
    const mime=Object.getOwnPropertyDescriptor(image,"mimeType"),bytes=Object.getOwnPropertyDescriptor(image,"bytes");
    if(!mime||!("value" in mime)||!bytes||!("value" in bytes))return refuse();
    const b=bytes.value,mimeType=mime.value;
    if(!["image/png","image/jpeg"].includes(mimeType)||types.isProxy(b)||!Buffer.isBuffer(b)||Object.getPrototypeOf(b)!==Buffer.prototype||["length","subarray","toString"].some(key=>Object.hasOwn(b,key)))return refuse();
    if(!b.length||(total+=b.length)>STANDING_VISUAL_BYTES)return refuse();
    if(mimeType==="image/png"?!b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):b.length<3||b[0]!==255||b[1]!==216||b[2]!==255)return refuse();
    output.push(Object.freeze({mimeType,base64:b.toString("base64")}));
  }
  return Object.freeze(output);
}
