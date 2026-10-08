import { rgbaFromHex, rgbaToHex } from "../pixel/RgbaImage.js";
import type {
  ColorMode,
  IAsepriteGateway,
  ReadRegionRequest,
  Rect,
  SpriteInfo,
  WriteRegionRequest,
} from "./AsepriteGateway.js";
import type { IAsepriteRpc } from "./AsepriteSocket.js";

/** Typed Aseprite operations on top of the raw method/params channel. */
export class RpcAsepriteGateway implements IAsepriteGateway {
  constructor(private readonly rpc: IAsepriteRpc) {}

  isConnected(): boolean {
    return this.rpc.isConnected();
  }

  getSpriteInfo(): Promise<SpriteInfo> {
    return this.rpc.call("get_sprite_info", {});
  }

  createSprite(options: { width: number; height: number; colorMode?: ColorMode }): Promise<SpriteInfo> {
    return this.rpc.call("create_sprite", options);
  }

  async readRegion(request: ReadRegionRequest) {
    const reply = await this.rpc.call<Rect & { rgba: string }>("read_region", request);
    const rect = { x: reply.x, y: reply.y, width: reply.width, height: reply.height };
    return { rect, image: rgbaFromHex(reply.rgba, rect.width, rect.height) };
  }

  async writeRegion(request: WriteRegionRequest): Promise<void> {
    const { image, ...rest } = request;
    await this.rpc.call("write_region", {
      ...rest,
      width: image.width,
      height: image.height,
      rgba: rgbaToHex(image),
    });
  }

  async getPalette(): Promise<string[]> {
    const reply = await this.rpc.call<{ colors: string[] }>("get_palette", {});
    return reply.colors.map((c) => `#${c}`);
  }
}
