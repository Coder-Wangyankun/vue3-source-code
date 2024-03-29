'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

var vue = require('vue');
var shared = require('@vue/shared');
var compilerSsr = require('@vue/compiler-ssr');

// leading comma for empty string ""
const shouldIgnoreProp = shared.makeMap(`,key,ref,innerHTML,textContent,ref_key,ref_for`);
function ssrRenderAttrs(props, tag) {
    let ret = '';
    for (const key in props) {
        if (shouldIgnoreProp(key) ||
            shared.isOn(key) ||
            (tag === 'textarea' && key === 'value')) {
            continue;
        }
        const value = props[key];
        if (key === 'class') {
            ret += ` class="${ssrRenderClass(value)}"`;
        }
        else if (key === 'style') {
            ret += ` style="${ssrRenderStyle(value)}"`;
        }
        else {
            ret += ssrRenderDynamicAttr(key, value, tag);
        }
    }
    return ret;
}
// render an attr with dynamic (unknown) key.
function ssrRenderDynamicAttr(key, value, tag) {
    if (!isRenderableValue(value)) {
        return ``;
    }
    const attrKey = tag && tag.indexOf('-') > 0
        ? key // preserve raw name on custom elements
        : shared.propsToAttrMap[key] || key.toLowerCase();
    if (shared.isBooleanAttr(attrKey)) {
        return shared.includeBooleanAttr(value) ? ` ${attrKey}` : ``;
    }
    else if (shared.isSSRSafeAttrName(attrKey)) {
        return value === '' ? ` ${attrKey}` : ` ${attrKey}="${shared.escapeHtml(value)}"`;
    }
    else {
        console.warn(`[@vue/server-renderer] Skipped rendering unsafe attribute name: ${attrKey}`);
        return ``;
    }
}
// Render a v-bind attr with static key. The key is pre-processed at compile
// time and we only need to check and escape value.
function ssrRenderAttr(key, value) {
    if (!isRenderableValue(value)) {
        return ``;
    }
    return ` ${key}="${shared.escapeHtml(value)}"`;
}
function isRenderableValue(value) {
    if (value == null) {
        return false;
    }
    const type = typeof value;
    return type === 'string' || type === 'number' || type === 'boolean';
}
function ssrRenderClass(raw) {
    return shared.escapeHtml(shared.normalizeClass(raw));
}
function ssrRenderStyle(raw) {
    if (!raw) {
        return '';
    }
    if (shared.isString(raw)) {
        return shared.escapeHtml(raw);
    }
    const styles = shared.normalizeStyle(raw);
    return shared.escapeHtml(shared.stringifyStyle(styles));
}

const compileCache = Object.create(null);
function ssrCompile(template, instance) {
    // TODO: This is copied from runtime-core/src/component.ts and should probably be refactored
    const Component = instance.type;
    const { isCustomElement, compilerOptions } = instance.appContext.config;
    const { delimiters, compilerOptions: componentCompilerOptions } = Component;
    const finalCompilerOptions = shared.extend(shared.extend({
        isCustomElement,
        delimiters
    }, compilerOptions), componentCompilerOptions);
    finalCompilerOptions.isCustomElement =
        finalCompilerOptions.isCustomElement || shared.NO;
    finalCompilerOptions.isNativeTag = finalCompilerOptions.isNativeTag || shared.NO;
    const cacheKey = JSON.stringify({
        template,
        compilerOptions: finalCompilerOptions
    }, (key, value) => {
        return shared.isFunction(value) ? value.toString() : value;
    });
    const cached = compileCache[cacheKey];
    if (cached) {
        return cached;
    }
    finalCompilerOptions.onError = (err) => {
        {
            const message = `[@vue/server-renderer] Template compilation error: ${err.message}`;
            const codeFrame = err.loc &&
                shared.generateCodeFrame(template, err.loc.start.offset, err.loc.end.offset);
            vue.warn(codeFrame ? `${message}\n${codeFrame}` : message);
        }
    };
    const { code } = compilerSsr.compile(template, finalCompilerOptions);
    return (compileCache[cacheKey] = Function('require', code)(require));
}

function ssrRenderTeleport(parentPush, contentRenderFn, target, disabled, parentComponent) {
    parentPush('<!--teleport start-->');
    const context = parentComponent.appContext.provides[vue.ssrContextKey];
    const teleportBuffers = context.__teleportBuffers || (context.__teleportBuffers = {});
    const targetBuffer = teleportBuffers[target] || (teleportBuffers[target] = []);
    // record current index of the target buffer to handle nested teleports
    // since the parent needs to be rendered before the child
    const bufferIndex = targetBuffer.length;
    let teleportContent;
    if (disabled) {
        contentRenderFn(parentPush);
        teleportContent = `<!--teleport anchor-->`;
    }
    else {
        const { getBuffer, push } = createBuffer();
        contentRenderFn(push);
        push(`<!--teleport anchor-->`);
        teleportContent = getBuffer();
    }
    targetBuffer.splice(bufferIndex, 0, teleportContent);
    parentPush('<!--teleport end-->');
}

const { createComponentInstance, setCurrentRenderingInstance, setupComponent, renderComponentRoot, normalizeVNode } = vue.ssrUtils;
// Each component has a buffer array.
// A buffer array can contain one of the following:
// - plain string
// - A resolved buffer (recursive arrays of strings that can be unrolled
//   synchronously)
// - An async buffer (a Promise that resolves to a resolved buffer)
function createBuffer() {
    let appendable = false;
    const buffer = [];
    return {
        getBuffer() {
            // Return static buffer and await on items during unroll stage
            return buffer;
        },
        push(item) {
            const isStringItem = shared.isString(item);
            if (appendable && isStringItem) {
                buffer[buffer.length - 1] += item;
            }
            else {
                buffer.push(item);
            }
            appendable = isStringItem;
            if (shared.isPromise(item) || (shared.isArray(item) && item.hasAsync)) {
                // promise, or child buffer with async, mark as async.
                // this allows skipping unnecessary await ticks during unroll stage
                buffer.hasAsync = true;
            }
        }
    };
}
function renderComponentVNode(vnode, parentComponent = null, slotScopeId) {
    const instance = createComponentInstance(vnode, parentComponent, null);
    const res = setupComponent(instance, true /* isSSR */);
    const hasAsyncSetup = shared.isPromise(res);
    const prefetches = instance.sp; /* LifecycleHooks.SERVER_PREFETCH */
    if (hasAsyncSetup || prefetches) {
        let p = hasAsyncSetup
            ? res
            : Promise.resolve();
        if (prefetches) {
            p = p
                .then(() => Promise.all(prefetches.map(prefetch => prefetch.call(instance.proxy))))
                // Note: error display is already done by the wrapped lifecycle hook function.
                .catch(() => { });
        }
        return p.then(() => renderComponentSubTree(instance, slotScopeId));
    }
    else {
        return renderComponentSubTree(instance, slotScopeId);
    }
}
function renderComponentSubTree(instance, slotScopeId) {
    const comp = instance.type;
    const { getBuffer, push } = createBuffer();
    if (shared.isFunction(comp)) {
        let root = renderComponentRoot(instance);
        // #5817 scope ID attrs not falling through if functional component doesn't
        // have props
        if (!comp.props) {
            for (const key in instance.attrs) {
                if (key.startsWith(`data-v-`)) {
                    (root.props || (root.props = {}))[key] = ``;
                }
            }
        }
        renderVNode(push, (instance.subTree = root), instance, slotScopeId);
    }
    else {
        if ((!instance.render || instance.render === shared.NOOP) &&
            !instance.ssrRender &&
            !comp.ssrRender &&
            shared.isString(comp.template)) {
            comp.ssrRender = ssrCompile(comp.template, instance);
        }
        // perf: enable caching of computed getters during render
        // since there cannot be state mutations during render.
        for (const e of instance.scope.effects) {
            if (e.computed)
                e.computed._cacheable = true;
        }
        const ssrRender = instance.ssrRender || comp.ssrRender;
        if (ssrRender) {
            // optimized
            // resolve fallthrough attrs
            let attrs = instance.inheritAttrs !== false ? instance.attrs : undefined;
            let hasCloned = false;
            let cur = instance;
            while (true) {
                const scopeId = cur.vnode.scopeId;
                if (scopeId) {
                    if (!hasCloned) {
                        attrs = { ...attrs };
                        hasCloned = true;
                    }
                    attrs[scopeId] = '';
                }
                const parent = cur.parent;
                if (parent && parent.subTree && parent.subTree === cur.vnode) {
                    // parent is a non-SSR compiled component and is rendering this
                    // component as root. inherit its scopeId if present.
                    cur = parent;
                }
                else {
                    break;
                }
            }
            if (slotScopeId) {
                if (!hasCloned)
                    attrs = { ...attrs };
                attrs[slotScopeId.trim()] = '';
            }
            // set current rendering instance for asset resolution
            const prev = setCurrentRenderingInstance(instance);
            ssrRender(instance.proxy, push, instance, attrs, 
            // compiler-optimized bindings
            instance.props, instance.setupState, instance.data, instance.ctx);
            setCurrentRenderingInstance(prev);
        }
        else if (instance.render && instance.render !== shared.NOOP) {
            renderVNode(push, (instance.subTree = renderComponentRoot(instance)), instance, slotScopeId);
        }
        else {
            const componentName = comp.name || comp.__file || `<Anonymous>`;
            vue.warn(`Component ${componentName} is missing template or render function.`);
            push(`<!---->`);
        }
    }
    return getBuffer();
}
function renderVNode(push, vnode, parentComponent, slotScopeId) {
    const { type, shapeFlag, children } = vnode;
    switch (type) {
        case vue.Text:
            push(shared.escapeHtml(children));
            break;
        case vue.Comment:
            push(children ? `<!--${shared.escapeHtmlComment(children)}-->` : `<!---->`);
            break;
        case vue.Static:
            push(children);
            break;
        case vue.Fragment:
            if (vnode.slotScopeIds) {
                slotScopeId =
                    (slotScopeId ? slotScopeId + ' ' : '') + vnode.slotScopeIds.join(' ');
            }
            push(`<!--[-->`); // open
            renderVNodeChildren(push, children, parentComponent, slotScopeId);
            push(`<!--]-->`); // close
            break;
        default:
            if (shapeFlag & 1 /* ShapeFlags.ELEMENT */) {
                renderElementVNode(push, vnode, parentComponent, slotScopeId);
            }
            else if (shapeFlag & 6 /* ShapeFlags.COMPONENT */) {
                push(renderComponentVNode(vnode, parentComponent, slotScopeId));
            }
            else if (shapeFlag & 64 /* ShapeFlags.TELEPORT */) {
                renderTeleportVNode(push, vnode, parentComponent, slotScopeId);
            }
            else if (shapeFlag & 128 /* ShapeFlags.SUSPENSE */) {
                renderVNode(push, vnode.ssContent, parentComponent, slotScopeId);
            }
            else {
                vue.warn('[@vue/server-renderer] Invalid VNode type:', type, `(${typeof type})`);
            }
    }
}
function renderVNodeChildren(push, children, parentComponent, slotScopeId) {
    for (let i = 0; i < children.length; i++) {
        renderVNode(push, normalizeVNode(children[i]), parentComponent, slotScopeId);
    }
}
function renderElementVNode(push, vnode, parentComponent, slotScopeId) {
    const tag = vnode.type;
    let { props, children, shapeFlag, scopeId, dirs } = vnode;
    let openTag = `<${tag}`;
    if (dirs) {
        props = applySSRDirectives(vnode, props, dirs);
    }
    if (props) {
        openTag += ssrRenderAttrs(props, tag);
    }
    if (scopeId) {
        openTag += ` ${scopeId}`;
    }
    // inherit parent chain scope id if this is the root node
    let curParent = parentComponent;
    let curVnode = vnode;
    while (curParent && curVnode === curParent.subTree) {
        curVnode = curParent.vnode;
        if (curVnode.scopeId) {
            openTag += ` ${curVnode.scopeId}`;
        }
        curParent = curParent.parent;
    }
    if (slotScopeId) {
        openTag += ` ${slotScopeId}`;
    }
    push(openTag + `>`);
    if (!shared.isVoidTag(tag)) {
        let hasChildrenOverride = false;
        if (props) {
            if (props.innerHTML) {
                hasChildrenOverride = true;
                push(props.innerHTML);
            }
            else if (props.textContent) {
                hasChildrenOverride = true;
                push(shared.escapeHtml(props.textContent));
            }
            else if (tag === 'textarea' && props.value) {
                hasChildrenOverride = true;
                push(shared.escapeHtml(props.value));
            }
        }
        if (!hasChildrenOverride) {
            if (shapeFlag & 8 /* ShapeFlags.TEXT_CHILDREN */) {
                push(shared.escapeHtml(children));
            }
            else if (shapeFlag & 16 /* ShapeFlags.ARRAY_CHILDREN */) {
                renderVNodeChildren(push, children, parentComponent, slotScopeId);
            }
        }
        push(`</${tag}>`);
    }
}
function applySSRDirectives(vnode, rawProps, dirs) {
    const toMerge = [];
    for (let i = 0; i < dirs.length; i++) {
        const binding = dirs[i];
        const { dir: { getSSRProps } } = binding;
        if (getSSRProps) {
            const props = getSSRProps(binding, vnode);
            if (props)
                toMerge.push(props);
        }
    }
    return vue.mergeProps(rawProps || {}, ...toMerge);
}
function renderTeleportVNode(push, vnode, parentComponent, slotScopeId) {
    const target = vnode.props && vnode.props.to;
    const disabled = vnode.props && vnode.props.disabled;
    if (!target) {
        if (!disabled) {
            vue.warn(`[@vue/server-renderer] Teleport is missing target prop.`);
        }
        return [];
    }
    if (!shared.isString(target)) {
        vue.warn(`[@vue/server-renderer] Teleport target must be a query selector string.`);
        return [];
    }
    ssrRenderTeleport(push, push => {
        renderVNodeChildren(push, vnode.children, parentComponent, slotScopeId);
    }, target, disabled || disabled === '', parentComponent);
}

const { isVNode } = vue.ssrUtils;
async function unrollBuffer(buffer) {
    if (buffer.hasAsync) {
        let ret = '';
        for (let i = 0; i < buffer.length; i++) {
            let item = buffer[i];
            if (shared.isPromise(item)) {
                item = await item;
            }
            if (shared.isString(item)) {
                ret += item;
            }
            else {
                ret += await unrollBuffer(item);
            }
        }
        return ret;
    }
    else {
        // sync buffer can be more efficiently unrolled without unnecessary await
        // ticks
        return unrollBufferSync(buffer);
    }
}
function unrollBufferSync(buffer) {
    let ret = '';
    for (let i = 0; i < buffer.length; i++) {
        let item = buffer[i];
        if (shared.isString(item)) {
            ret += item;
        }
        else {
            // since this is a sync buffer, child buffers are never promises
            ret += unrollBufferSync(item);
        }
    }
    return ret;
}
async function renderToString(input, context = {}) {
    if (isVNode(input)) {
        // raw vnode, wrap with app (for context)
        return renderToString(vue.createApp({ render: () => input }), context);
    }
    // rendering an app
    const vnode = vue.createVNode(input._component, input._props);
    vnode.appContext = input._context;
    // provide the ssr context to the tree
    input.provide(vue.ssrContextKey, context);
    const buffer = await renderComponentVNode(vnode);
    const result = await unrollBuffer(buffer);
    await resolveTeleports(context);
    return result;
}
async function resolveTeleports(context) {
    if (context.__teleportBuffers) {
        context.teleports = context.teleports || {};
        for (const key in context.__teleportBuffers) {
            // note: it's OK to await sequentially here because the Promises were
            // created eagerly in parallel.
            context.teleports[key] = await unrollBuffer(await Promise.all([context.__teleportBuffers[key]]));
        }
    }
}

const { isVNode: isVNode$1 } = vue.ssrUtils;
async function unrollBuffer$1(buffer, stream) {
    if (buffer.hasAsync) {
        for (let i = 0; i < buffer.length; i++) {
            let item = buffer[i];
            if (shared.isPromise(item)) {
                item = await item;
            }
            if (shared.isString(item)) {
                stream.push(item);
            }
            else {
                await unrollBuffer$1(item, stream);
            }
        }
    }
    else {
        // sync buffer can be more efficiently unrolled without unnecessary await
        // ticks
        unrollBufferSync$1(buffer, stream);
    }
}
function unrollBufferSync$1(buffer, stream) {
    for (let i = 0; i < buffer.length; i++) {
        let item = buffer[i];
        if (shared.isString(item)) {
            stream.push(item);
        }
        else {
            // since this is a sync buffer, child buffers are never promises
            unrollBufferSync$1(item, stream);
        }
    }
}
function renderToSimpleStream(input, context, stream) {
    if (isVNode$1(input)) {
        // raw vnode, wrap with app (for context)
        return renderToSimpleStream(vue.createApp({ render: () => input }), context, stream);
    }
    // rendering an app
    const vnode = vue.createVNode(input._component, input._props);
    vnode.appContext = input._context;
    // provide the ssr context to the tree
    input.provide(vue.ssrContextKey, context);
    Promise.resolve(renderComponentVNode(vnode))
        .then(buffer => unrollBuffer$1(buffer, stream))
        .then(() => resolveTeleports(context))
        .then(() => stream.push(null))
        .catch(error => {
        stream.destroy(error);
    });
    return stream;
}
/**
 * @deprecated
 */
function renderToStream(input, context = {}) {
    console.warn(`[@vue/server-renderer] renderToStream is deprecated - use renderToNodeStream instead.`);
    return renderToNodeStream(input, context);
}
function renderToNodeStream(input, context = {}) {
    const stream = new (require('stream').Readable)({ read() { } })
        ;
    if (!stream) {
        throw new Error(`ESM build of renderToStream() does not support renderToNodeStream(). ` +
            `Use pipeToNodeWritable() with an existing Node.js Writable stream ` +
            `instance instead.`);
    }
    return renderToSimpleStream(input, context, stream);
}
function pipeToNodeWritable(input, context = {}, writable) {
    renderToSimpleStream(input, context, {
        push(content) {
            if (content != null) {
                writable.write(content);
            }
            else {
                writable.end();
            }
        },
        destroy(err) {
            writable.destroy(err);
        }
    });
}
function renderToWebStream(input, context = {}) {
    if (typeof ReadableStream !== 'function') {
        throw new Error(`ReadableStream constructor is not available in the global scope. ` +
            `If the target environment does support web streams, consider using ` +
            `pipeToWebWritable() with an existing WritableStream instance instead.`);
    }
    const encoder = new TextEncoder();
    let cancelled = false;
    return new ReadableStream({
        start(controller) {
            renderToSimpleStream(input, context, {
                push(content) {
                    if (cancelled)
                        return;
                    if (content != null) {
                        controller.enqueue(encoder.encode(content));
                    }
                    else {
                        controller.close();
                    }
                },
                destroy(err) {
                    controller.error(err);
                }
            });
        },
        cancel() {
            cancelled = true;
        }
    });
}
function pipeToWebWritable(input, context = {}, writable) {
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    // #4287 CloudFlare workers do not implement `ready` property
    let hasReady = false;
    try {
        hasReady = shared.isPromise(writer.ready);
    }
    catch (e) { }
    renderToSimpleStream(input, context, {
        async push(content) {
            if (hasReady) {
                await writer.ready;
            }
            if (content != null) {
                return writer.write(encoder.encode(content));
            }
            else {
                return writer.close();
            }
        },
        destroy(err) {
            // TODO better error handling?
            console.log(err);
            writer.close();
        }
    });
}

function ssrRenderComponent(comp, props = null, children = null, parentComponent = null, slotScopeId) {
    return renderComponentVNode(vue.createVNode(comp, props, children), parentComponent, slotScopeId);
}

function ssrRenderSlot(slots, slotName, slotProps, fallbackRenderFn, push, parentComponent, slotScopeId) {
    // template-compiled slots are always rendered as fragments
    push(`<!--[-->`);
    ssrRenderSlotInner(slots, slotName, slotProps, fallbackRenderFn, push, parentComponent, slotScopeId);
    push(`<!--]-->`);
}
function ssrRenderSlotInner(slots, slotName, slotProps, fallbackRenderFn, push, parentComponent, slotScopeId, transition) {
    const slotFn = slots[slotName];
    if (slotFn) {
        const slotBuffer = [];
        const bufferedPush = (item) => {
            slotBuffer.push(item);
        };
        const ret = slotFn(slotProps, bufferedPush, parentComponent, slotScopeId ? ' ' + slotScopeId : '');
        if (shared.isArray(ret)) {
            // normal slot
            renderVNodeChildren(push, ret, parentComponent, slotScopeId);
        }
        else {
            // ssr slot.
            // check if the slot renders all comments, in which case use the fallback
            let isEmptySlot = true;
            if (transition) {
                isEmptySlot = false;
            }
            else {
                for (let i = 0; i < slotBuffer.length; i++) {
                    if (!isComment(slotBuffer[i])) {
                        isEmptySlot = false;
                        break;
                    }
                }
            }
            if (isEmptySlot) {
                if (fallbackRenderFn) {
                    fallbackRenderFn();
                }
            }
            else {
                for (let i = 0; i < slotBuffer.length; i++) {
                    push(slotBuffer[i]);
                }
            }
        }
    }
    else if (fallbackRenderFn) {
        fallbackRenderFn();
    }
}
const commentTestRE = /^<!--.*-->$/s;
const commentRE = /<!--[^]*?-->/gm;
function isComment(item) {
    if (typeof item !== 'string' || !commentTestRE.test(item))
        return false;
    // if item is '<!---->' or '<!--[-->' or '<!--]-->', return true directly
    if (item.length <= 8)
        return true;
    return !item.replace(commentRE, '').trim();
}

function ssrInterpolate(value) {
    return shared.escapeHtml(shared.toDisplayString(value));
}

function toRaw(observed) {
    const raw = observed && observed["__v_raw" /* ReactiveFlags.RAW */];
    return raw ? toRaw(raw) : observed;
}

function isRef(r) {
    return !!(r && r.__v_isRef === true);
}

const stack = [];
function pushWarningContext(vnode) {
    stack.push(vnode);
}
function popWarningContext() {
    stack.pop();
}
function warn(msg, ...args) {
    const instance = stack.length ? stack[stack.length - 1].component : null;
    const appWarnHandler = instance && instance.appContext.config.warnHandler;
    const trace = getComponentTrace();
    if (appWarnHandler) {
        callWithErrorHandling(appWarnHandler, instance, 11 /* ErrorCodes.APP_WARN_HANDLER */, [
            msg + args.join(''),
            instance && instance.proxy,
            trace
                .map(({ vnode }) => `at <${formatComponentName(instance, vnode.type)}>`)
                .join('\n'),
            trace
        ]);
    }
    else {
        const warnArgs = [`[Vue warn]: ${msg}`, ...args];
        /* istanbul ignore if */
        if (trace.length &&
            // avoid spamming console during tests
            !false) {
            warnArgs.push(`\n`, ...formatTrace(trace));
        }
        console.warn(...warnArgs);
    }
}
function getComponentTrace() {
    let currentVNode = stack[stack.length - 1];
    if (!currentVNode) {
        return [];
    }
    // we can't just use the stack because it will be incomplete during updates
    // that did not start from the root. Re-construct the parent chain using
    // instance parent pointers.
    const normalizedStack = [];
    while (currentVNode) {
        const last = normalizedStack[0];
        if (last && last.vnode === currentVNode) {
            last.recurseCount++;
        }
        else {
            normalizedStack.push({
                vnode: currentVNode,
                recurseCount: 0
            });
        }
        const parentInstance = currentVNode.component && currentVNode.component.parent;
        currentVNode = parentInstance && parentInstance.vnode;
    }
    return normalizedStack;
}
/* istanbul ignore next */
function formatTrace(trace) {
    const logs = [];
    trace.forEach((entry, i) => {
        logs.push(...(i === 0 ? [] : [`\n`]), ...formatTraceEntry(entry));
    });
    return logs;
}
function formatTraceEntry({ vnode, recurseCount }) {
    const postfix = recurseCount > 0 ? `... (${recurseCount} recursive calls)` : ``;
    const isRoot = vnode.component ? vnode.component.parent == null : false;
    const open = ` at <${formatComponentName(vnode.component, vnode.type, isRoot)}`;
    const close = `>` + postfix;
    return vnode.props
        ? [open, ...formatProps(vnode.props), close]
        : [open + close];
}
/* istanbul ignore next */
function formatProps(props) {
    const res = [];
    const keys = Object.keys(props);
    keys.slice(0, 3).forEach(key => {
        res.push(...formatProp(key, props[key]));
    });
    if (keys.length > 3) {
        res.push(` ...`);
    }
    return res;
}
/* istanbul ignore next */
function formatProp(key, value, raw) {
    if (shared.isString(value)) {
        value = JSON.stringify(value);
        return raw ? value : [`${key}=${value}`];
    }
    else if (typeof value === 'number' ||
        typeof value === 'boolean' ||
        value == null) {
        return raw ? value : [`${key}=${value}`];
    }
    else if (isRef(value)) {
        value = formatProp(key, toRaw(value.value), true);
        return raw ? value : [`${key}=Ref<`, value, `>`];
    }
    else if (shared.isFunction(value)) {
        return [`${key}=fn${value.name ? `<${value.name}>` : ``}`];
    }
    else {
        value = toRaw(value);
        return raw ? value : [`${key}=`, value];
    }
}

const ErrorTypeStrings = {
    ["sp" /* LifecycleHooks.SERVER_PREFETCH */]: 'serverPrefetch hook',
    ["bc" /* LifecycleHooks.BEFORE_CREATE */]: 'beforeCreate hook',
    ["c" /* LifecycleHooks.CREATED */]: 'created hook',
    ["bm" /* LifecycleHooks.BEFORE_MOUNT */]: 'beforeMount hook',
    ["m" /* LifecycleHooks.MOUNTED */]: 'mounted hook',
    ["bu" /* LifecycleHooks.BEFORE_UPDATE */]: 'beforeUpdate hook',
    ["u" /* LifecycleHooks.UPDATED */]: 'updated',
    ["bum" /* LifecycleHooks.BEFORE_UNMOUNT */]: 'beforeUnmount hook',
    ["um" /* LifecycleHooks.UNMOUNTED */]: 'unmounted hook',
    ["a" /* LifecycleHooks.ACTIVATED */]: 'activated hook',
    ["da" /* LifecycleHooks.DEACTIVATED */]: 'deactivated hook',
    ["ec" /* LifecycleHooks.ERROR_CAPTURED */]: 'errorCaptured hook',
    ["rtc" /* LifecycleHooks.RENDER_TRACKED */]: 'renderTracked hook',
    ["rtg" /* LifecycleHooks.RENDER_TRIGGERED */]: 'renderTriggered hook',
    [0 /* ErrorCodes.SETUP_FUNCTION */]: 'setup function',
    [1 /* ErrorCodes.RENDER_FUNCTION */]: 'render function',
    [2 /* ErrorCodes.WATCH_GETTER */]: 'watcher getter',
    [3 /* ErrorCodes.WATCH_CALLBACK */]: 'watcher callback',
    [4 /* ErrorCodes.WATCH_CLEANUP */]: 'watcher cleanup function',
    [5 /* ErrorCodes.NATIVE_EVENT_HANDLER */]: 'native event handler',
    [6 /* ErrorCodes.COMPONENT_EVENT_HANDLER */]: 'component event handler',
    [7 /* ErrorCodes.VNODE_HOOK */]: 'vnode hook',
    [8 /* ErrorCodes.DIRECTIVE_HOOK */]: 'directive hook',
    [9 /* ErrorCodes.TRANSITION_HOOK */]: 'transition hook',
    [10 /* ErrorCodes.APP_ERROR_HANDLER */]: 'app errorHandler',
    [11 /* ErrorCodes.APP_WARN_HANDLER */]: 'app warnHandler',
    [12 /* ErrorCodes.FUNCTION_REF */]: 'ref function',
    [13 /* ErrorCodes.ASYNC_COMPONENT_LOADER */]: 'async component loader',
    [14 /* ErrorCodes.SCHEDULER */]: 'scheduler flush. This is likely a Vue internals bug. ' +
        'Please open an issue at https://new-issue.vuejs.org/?repo=vuejs/core'
};
function callWithErrorHandling(fn, instance, type, args) {
    let res;
    try {
        res = args ? fn(...args) : fn();
    }
    catch (err) {
        handleError(err, instance, type);
    }
    return res;
}
function handleError(err, instance, type, throwInDev = true) {
    const contextVNode = instance ? instance.vnode : null;
    if (instance) {
        let cur = instance.parent;
        // the exposed instance is the render proxy to keep it consistent with 2.x
        const exposedInstance = instance.proxy;
        // in production the hook receives only the error code
        const errorInfo = ErrorTypeStrings[type] ;
        while (cur) {
            const errorCapturedHooks = cur.ec;
            if (errorCapturedHooks) {
                for (let i = 0; i < errorCapturedHooks.length; i++) {
                    if (errorCapturedHooks[i](err, exposedInstance, errorInfo) === false) {
                        return;
                    }
                }
            }
            cur = cur.parent;
        }
        // app-level handling
        const appErrorHandler = instance.appContext.config.errorHandler;
        if (appErrorHandler) {
            callWithErrorHandling(appErrorHandler, null, 10 /* ErrorCodes.APP_ERROR_HANDLER */, [err, exposedInstance, errorInfo]);
            return;
        }
    }
    logError(err, type, contextVNode, throwInDev);
}
function logError(err, type, contextVNode, throwInDev = true) {
    {
        const info = ErrorTypeStrings[type];
        if (contextVNode) {
            pushWarningContext(contextVNode);
        }
        warn(`Unhandled error${info ? ` during execution of ${info}` : ``}`);
        if (contextVNode) {
            popWarningContext();
        }
        // crash in dev by default so it's more noticeable
        if (throwInDev) {
            throw err;
        }
        else {
            console.error(err);
        }
    }
}

const classifyRE = /(?:^|[-_])(\w)/g;
const classify = (str) => str.replace(classifyRE, c => c.toUpperCase()).replace(/[-_]/g, '');
function getComponentName(Component, includeInferred = true) {
    return shared.isFunction(Component)
        ? Component.displayName || Component.name
        : Component.name || (includeInferred && Component.__name);
}
/* istanbul ignore next */
function formatComponentName(instance, Component, isRoot = false) {
    let name = getComponentName(Component);
    if (!name && Component.__file) {
        const match = Component.__file.match(/([^/\\]+)\.\w+$/);
        if (match) {
            name = match[1];
        }
    }
    if (!name && instance && instance.parent) {
        // try to infer the name based on reverse resolution
        const inferFromRegistry = (registry) => {
            for (const key in registry) {
                if (registry[key] === Component) {
                    return key;
                }
            }
        };
        name =
            inferFromRegistry(instance.components ||
                instance.parent.type.components) || inferFromRegistry(instance.appContext.components);
    }
    return name ? classify(name) : isRoot ? `App` : `Anonymous`;
}

function ssrRenderList(source, renderItem) {
    if (shared.isArray(source) || shared.isString(source)) {
        for (let i = 0, l = source.length; i < l; i++) {
            renderItem(source[i], i);
        }
    }
    else if (typeof source === 'number') {
        if (!Number.isInteger(source)) {
            warn(`The v-for range expect an integer value but got ${source}.`);
            return;
        }
        for (let i = 0; i < source; i++) {
            renderItem(i + 1, i);
        }
    }
    else if (shared.isObject(source)) {
        if (source[Symbol.iterator]) {
            const arr = Array.from(source);
            for (let i = 0, l = arr.length; i < l; i++) {
                renderItem(arr[i], i);
            }
        }
        else {
            const keys = Object.keys(source);
            for (let i = 0, l = keys.length; i < l; i++) {
                const key = keys[i];
                renderItem(source[key], key, i);
            }
        }
    }
}

async function ssrRenderSuspense(push, { default: renderContent }) {
    if (renderContent) {
        renderContent();
    }
    else {
        push(`<!---->`);
    }
}

function ssrGetDirectiveProps(instance, dir, value, arg, modifiers = {}) {
    if (typeof dir !== 'function' && dir.getSSRProps) {
        return (dir.getSSRProps({
            dir,
            instance,
            value,
            oldValue: undefined,
            arg,
            modifiers
        }, null) || {});
    }
    return {};
}

const ssrLooseEqual = shared.looseEqual;
function ssrLooseContain(arr, value) {
    return shared.looseIndexOf(arr, value) > -1;
}
// for <input :type="type" v-model="model" value="value">
function ssrRenderDynamicModel(type, model, value) {
    switch (type) {
        case 'radio':
            return shared.looseEqual(model, value) ? ' checked' : '';
        case 'checkbox':
            return (shared.isArray(model) ? ssrLooseContain(model, value) : model)
                ? ' checked'
                : '';
        default:
            // text types
            return ssrRenderAttr('value', model);
    }
}
// for <input v-bind="obj" v-model="model">
function ssrGetDynamicModelProps(existingProps = {}, model) {
    const { type, value } = existingProps;
    switch (type) {
        case 'radio':
            return shared.looseEqual(model, value) ? { checked: true } : null;
        case 'checkbox':
            return (shared.isArray(model) ? ssrLooseContain(model, value) : model)
                ? { checked: true }
                : null;
        default:
            // text types
            return { value: model };
    }
}

vue.initDirectivesForSSR();

exports.ssrIncludeBooleanAttr = shared.includeBooleanAttr;
exports.pipeToNodeWritable = pipeToNodeWritable;
exports.pipeToWebWritable = pipeToWebWritable;
exports.renderToNodeStream = renderToNodeStream;
exports.renderToSimpleStream = renderToSimpleStream;
exports.renderToStream = renderToStream;
exports.renderToString = renderToString;
exports.renderToWebStream = renderToWebStream;
exports.ssrGetDirectiveProps = ssrGetDirectiveProps;
exports.ssrGetDynamicModelProps = ssrGetDynamicModelProps;
exports.ssrInterpolate = ssrInterpolate;
exports.ssrLooseContain = ssrLooseContain;
exports.ssrLooseEqual = ssrLooseEqual;
exports.ssrRenderAttr = ssrRenderAttr;
exports.ssrRenderAttrs = ssrRenderAttrs;
exports.ssrRenderClass = ssrRenderClass;
exports.ssrRenderComponent = ssrRenderComponent;
exports.ssrRenderDynamicAttr = ssrRenderDynamicAttr;
exports.ssrRenderDynamicModel = ssrRenderDynamicModel;
exports.ssrRenderList = ssrRenderList;
exports.ssrRenderSlot = ssrRenderSlot;
exports.ssrRenderSlotInner = ssrRenderSlotInner;
exports.ssrRenderStyle = ssrRenderStyle;
exports.ssrRenderSuspense = ssrRenderSuspense;
exports.ssrRenderTeleport = ssrRenderTeleport;
exports.ssrRenderVNode = renderVNode;
//# sourceMappingURL=server-renderer.cjs.js.map
