/** SAFETY: @deprecated Import from "./payload-contract.js" instead — compatibility shim retained until next MAJOR per ADR-0007. Single source: src/payload-contract.ts. */
/** SAFETY: @deprecated Use `import { normReq } from "./payload-contract.js"` */
export {
	/** SAFETY: @deprecated Use `import type { NormalizedEditRequest } from "./payload-contract.js"` */
	type NormalizedEditRequest,
	/** SAFETY: @deprecated Use `import { normReq } from "./payload-contract.js"` */
	normReq,
	/** SAFETY: @deprecated Use `import { prepareEditArguments } from "./payload-contract.js"` */
	prepareEditArguments,
} from "./payload-contract.js";
