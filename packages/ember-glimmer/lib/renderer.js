import { RootReference } from './utils/references';
import run from 'ember-metal/run_loop';
import { setHasViews } from 'ember-metal/tags';
import { CURRENT_TAG, UNDEFINED_REFERENCE } from 'glimmer-reference';
import fallbackViewRegistry from 'ember-views/compat/fallback-view-registry';
import { assert } from 'ember-metal/debug';
import _runInTransaction from 'ember-metal/transaction';
import isEnabled from 'ember-metal/features';
import { BOUNDS } from './component';
import { RootComponentDefinition } from './syntax/curly-component';
import { getViewId } from 'ember-views/system/utils';

let runInTransaction;

if (isEnabled('ember-glimmer-detect-backtracking-rerender') ||
    isEnabled('ember-glimmer-allow-backtracking-rerender')) {
  runInTransaction = _runInTransaction;
} else {
  runInTransaction = (context, methodName) => {
    context[methodName]();
    return false;
  };
}

const { backburner } = run;

class DynamicScope {
  constructor(view, outletState, rootOutletState, isTopLevel, targetObject) {
    this.view = view;
    this.outletState = outletState;
    this.rootOutletState = rootOutletState;
    this.isTopLevel = isTopLevel;
    this.targetObject = targetObject;
  }

  child() {
    return new DynamicScope(
      this.view, this.outletState, this.rootOutletState, this.isTopLevel, this.targetObject
    );
  }
}

let nextRootId = 0;
class RootState {
  constructor(env, root, template, self, parentElement, dynamicScope) {
    assert(`You cannot render \`${self.value()}\` without a template.`, template);

    this.id = ++nextRootId;
    this.env = env;
    this.root = root;
    this.template = template;
    this.self = self;
    this.parentElement = parentElement;
    this.dynamicScope = dynamicScope;

    this.options = {
      alwaysRevalidate: false
    };
    this.render = this.initialRender;
    this.result = undefined;
  }

  isFor(possibleRoot) {
    return this.root === possibleRoot;
  }

  initialRender() {
    this.result = this.template.asEntryPoint().render(this.self, this.env, {
      appendTo: this.parentElement,
      dynamicScope: this.dynamicScope
    });

    // change next render to use `rerender`
    this.render = this.rerender;
  }

  rerender() {
    this.result.rerender(this.options);
  }

  destroy() {
    let { result } = this;

    this.env = null;
    this.root = null;
    this.template = null;
    this.self = null;
    this.parentElement = null;
    this.dynamicScope = null;
    this.result = null;
    this.options = null;
    this.render = null;

    if (result) {
      result.destroy();
    }
  }
}

const renderers = [];

setHasViews(() => renderers.length > 0);

function register(renderer) {
  assert('Cannot register the same renderer twice', renderers.indexOf(renderer) === -1);
  renderers.push(renderer);
}

function deregister(renderer) {
  let index = renderers.indexOf(renderer);
  assert('Cannot deregister unknown unregistered renderer', index !== -1);
  renderers.splice(index, 1);
}

function loopBegin() {
  for (let i = 0; i < renderers.length; i++) {
    renderers[i]._scheduleRevalidate();
  }
}

function K() {}

let loops = 0;
function loopEnd(current, next) {
  for (let i = 0; i < renderers.length; i++) {
    if (!renderers[i]._isValid()) {
      if (loops > 10) {
        loops = 0;
        // TODO: do something better
        renderers[i].destroy();
        throw new Error('infinite rendering invalidation detected');
      }
      loops++;
      return backburner.join(null, K);
    }
  }
  loops = 0;
}

backburner.on('begin', loopBegin);
backburner.on('end', loopEnd);

export class Renderer {
  constructor(env, rootTemplate, _viewRegistry = fallbackViewRegistry, destinedForDOM = false) {
    this._env = env;
    this._rootTemplate = rootTemplate;
    this._viewRegistry = _viewRegistry;
    this._destinedForDOM = destinedForDOM;
    this._destroyed = false;
    this._roots = [];
    this._lastRevision = null;
    this._transaction = null;
  }

  // renderer HOOKS

  appendOutletView(view, target) {
    let self = new RootReference(view);
    let targetObject = view.outletState.render.controller;
    let ref = view.toReference();
    let dynamicScope = new DynamicScope(null, ref, ref, true, targetObject);
    let root = new RootState(this._env, view, view.template, self, target, dynamicScope);

    this._renderRoot(root);
  }

  appendTo(view, target) {
    let rootDef = new RootComponentDefinition(view);
    let self = new RootReference(rootDef);
    let dynamicScope = new DynamicScope(null, UNDEFINED_REFERENCE, UNDEFINED_REFERENCE, true, null);
    let root = new RootState(this._env, view, this._rootTemplate, self, target, dynamicScope);

    this._renderRoot(root);
  }

  rerender(view) {
    this._scheduleRevalidate();
  }

  componentInitAttrs() {
    // TODO: Remove me
  }

  ensureViewNotRendering() {
    // TODO: Implement this
    // throw new Error('Something you did caused a view to re-render after it rendered but before it was inserted into the DOM.');
  }

  register(view) {
    let id = getViewId(view);
    assert('Attempted to register a view with an id already in use: ' + id, !this._viewRegistry[id]);
    this._viewRegistry[id] = view;
  }

  unregister(view) {
    delete this._viewRegistry[getViewId(view)];
  }

  remove(view) {
    view.trigger('willDestroyElement');
    view.trigger('willClearRender');
    view._transitionTo('destroying');

    let roots = this._roots;

    // traverse in reverse so we can remove items
    // without mucking up the index
    for (let i = this._roots.length - 1; i > -1; i--) {
      let root = roots[i];
      if (root.isFor(view)) {
        root.destroy();
        roots.splice(i, 1);
      }
    }

    if (this._roots.length === 0) {
      deregister(this);
    }

    if (!view.isDestroying) {
      view.destroy();
    }
  }

  destroy() {
    if (this._destroyed) {
      return;
    }
    this._destroyed = true;
    this._clearAllRoots();
  }

  getBounds(view) {
    let bounds = view[BOUNDS];

    let parentElement = bounds.parentElement();
    let firstNode = bounds.firstNode();
    let lastNode = bounds.lastNode();

    return { parentElement, firstNode, lastNode };
  }

  createElement(tagName) {
    return this._env.getAppendOperations().createElement(tagName);
  }

  _renderRoot(root) {
    let { _roots: roots, _env: env } = this;

    roots.push(root);

    if (roots.length === 1) {
      register(this);
    }

    let transaction = () => {
      let shouldReflush = false;
      do {
        env.begin();

        for (let i = 0; i < roots.length; i++) {
          let root = roots[i];

          root.options.alwaysRevalidate = shouldReflush;
          shouldReflush = runInTransaction(root, 'render');
        }

        this._lastRevision = CURRENT_TAG.value();

        env.commit();
      } while (shouldReflush);
    };

    this._transaction = () => {
      try {
        transaction();
      } catch (e) {
        this.destroy();
        throw e;
      }
    };

    this._transaction();
  }

  _clearAllRoots() {
    let roots = this._roots;
    for (let i = 0; i < roots.length; i++) {
      let root = roots[i];
      root.destroy();
    }
    this._roots = null;
    this._transaction = null;

    if (roots.length) {
      deregister(this);
    }
  }

  _scheduleRevalidate() {
    backburner.scheduleOnce('render', this, this._revalidate);
  }

  _isValid() {
    return this._destroyed || this._roots.length === 0 || CURRENT_TAG.validate(this._lastRevision);
  }

  _revalidate() {
    if (this._isValid()) {
      return;
    }
    this._transaction();
  }
}

export const InertRenderer = {
  create({ env, rootTemplate, _viewRegistry }) {
    return new Renderer(env, rootTemplate, _viewRegistry, false);
  }
};

export const InteractiveRenderer = {
  create({ env, rootTemplate, _viewRegistry }) {
    return new Renderer(env, rootTemplate, _viewRegistry, true);
  }
};
