/**
 * @deprecated Import from "./payload-contract.js" instead. This module is a
 * compatibility shim retained until the next MAJOR per ADR-0007.
 * `src/payload-contract.ts` is the single source for the payload contract
 * (`editToolSchema`, `NormalizedEditRequest`, `normReq`, `prepareEditArguments`, …).
 */
/** @deprecated Use `import { normReq } from "./payload-contract.js"` */
export {
	/** @deprecated Use `import type { NormalizedEditRequest } from "./payload-contract.js"` */
	type NormalizedEditRequest,
	/** @deprecated Use `import { normReq } from "./payload-contract.js"` */
	normReq,
	/** @deprecated Use `import { prepareEditArguments } from "./payload-contract.js"` */
	prepareEditArguments,
} from "./payload-contract.js";
