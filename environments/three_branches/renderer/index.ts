/** Temporary registration renderer for Days at Three Branches.
 *
 * Stage 3 replaces this neutral surface with the village viewer. It intentionally draws no world
 * model or controls: registration only needs a stable, recording-safe indication of the current tick.
 */
import type { StepState } from "@game-sandbox/schema";
import { PixiRenderer } from "@renderers/base/PixiRenderer.js";
import type { RendererDefinition } from "@renderers/types.js";
import { type Container, Graphics, Text } from "pixi.js";
import thumbnail from "./thumbnail.svg";

export class ThreeBranchesRenderer extends PixiRenderer {
  readonly internalSize = { width: 800, height: 450 } as const;

  private tickLabel!: Text;

  protected setup(root: Container): void {
    const background = new Graphics().rect(0, 0, 800, 450).fill("#263238");
    root.addChild(background);

    const title = this.text("Days at Three Branches", 38, "#f5f3ea", "center");
    title.position.set(400, 190);
    root.addChild(title);

    this.tickLabel = this.text("", 24, "#b8c7c4", "center");
    this.tickLabel.position.set(400, 245);
    root.addChild(this.tickLabel);
  }

  protected update(state: StepState): void {
    const overlay = state.overlay ?? {};
    const tick = typeof overlay.tick === "number" ? overlay.tick : state.tick;
    this.tickLabel.text = `Tick ${tick}`;
    this.tickLabel.resolution = this.textResolution();
  }
}

const definition = {
  key: "three-branches-village",
  renderer: ThreeBranchesRenderer,
  thumbnail,
} satisfies RendererDefinition;

export default definition;
