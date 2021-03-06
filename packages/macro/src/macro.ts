import { NodePath, types } from "@babel/core";
import { createMacro, MacroError, MacroParams } from "babel-plugin-macros";

import corePlugins from "tailwindcss/lib/corePlugins";

import {
  resolveTailwindConfigPath,
  requireTailwindConfig,
  TailwindConfig,
} from "@tailwindcssinjs/tailwindcss-data/lib/tailwindcssConfig";

import {
  twClassesSerializer,
  TwClasses,
} from "@tailwindcssinjs/class-composer";

import tailwindcssinjs from "./tailwindcssinjs";
import { generateDevCorePlugins } from "./devCorePluginsGenerator";

/**
 * Returns tailwind classes from macro arguments
 * @param path
 */
function getArgs(path: NodePath<types.Node>): TwClasses {
  if (path.type === "CallExpression") {
    const node = path as NodePath<types.CallExpression>;
    return node.get("arguments").map((item) => item.evaluate().value);
  }

  if (path.type === "TaggedTemplateExpression") {
    const node = path as NodePath<types.TaggedTemplateExpression>;
    const quasi = node.get("quasi");
    const templateElements = quasi
      .get("quasis")
      .map((item) => item.node.value.raw);

    const expressions = quasi
      .get("expressions")
      .map((item) => item.evaluate().value);
    const twClasses = [];
    while (templateElements.length || expressions.length) {
      const twClassString = templateElements.shift();
      const twClassObject = expressions.shift();
      if (twClassString) {
        twClasses.push(twClassString);
      }
      if (twClassObject) {
        twClasses.push(twClassObject);
      }
    }
    return twClasses;
  }

  throw new Error("Invalid Nodepath");
}

/**
 * Add development imports to the file this enables hot reloading on config changes
 *
 * Example imports:
 * import tailwindconfig from "ABSULUTEPATH/tailwind.config";
 * import devCorePlugins from "@tailwindcssinjs/macro/lib/devCorePlugins"
 * import tailwindcssinjs from "@tailwindcssinjs/macro/lib/tailwindcssinjs";
 * const tw = tailwindcssinjs(tailwindconfig, devCorePlugins);
 * @param referencePath
 * @param t
 * @param state
 */
function addDevImports(
  referencePath: NodePath<types.Node>,
  t: typeof types,
  state: TailwindMacroParamsState
) {
  //check if file already has dev imports
  if (!state.tailwindDevTwUid) {
    //create tailwindconfig importDeclaration:
    //import tailwindconfig from "ABSULUTEPATH/tailwind.config";
    const tailwindConfigUid = referencePath.scope.generateUidIdentifier(
      "tailwindconfig"
    );
    const tailwindConfigImport = t.importDeclaration(
      [t.importDefaultSpecifier(tailwindConfigUid)],
      t.stringLiteral(
        state.tailwindConfigPath
          ? state.tailwindConfigPath
          : "tailwindcss/defaultConfig"
      )
    );

    //create devCorePlugins importDeclaration:
    //import devCorePlugins from "@tailwindcssinjs/macro/lib/devCorePlugins"
    const devCorePluginsUid = referencePath.scope.generateUidIdentifier(
      "devCorePlugins"
    );
    const corePluginsImport = t.importDeclaration(
      [t.importDefaultSpecifier(devCorePluginsUid)],
      t.stringLiteral("@tailwindcssinjs/macro/lib/devCorePlugins")
    );

    //create tailwindcssinjs importDeclaration:
    //import tailwindcssinjs from "@tailwindcssinjs/macro/lib/tailwindcssinjs";
    const tailwindcssinjsUid = referencePath.scope.generateUidIdentifier(
      "tailwindcssinjs"
    );
    const tailwindcssinjsImport = t.importDeclaration(
      [t.importDefaultSpecifier(tailwindcssinjsUid)],
      t.stringLiteral("@tailwindcssinjs/macro/lib/tailwindcssinjs")
    );

    //create tw variableDeclaration:
    //const tw = tailwindcssinjs(tailwindconfig, devCorePlugins);
    const twUid = referencePath.scope.generateUidIdentifier("tw");
    const twConst = t.variableDeclaration("const", [
      t.variableDeclarator(
        twUid,
        t.callExpression(tailwindcssinjsUid, [
          tailwindConfigUid,
          devCorePluginsUid,
        ])
      ),
    ]);

    //store uids in state
    state.tailwindDevTwUid = twUid;

    //add devImports nodes to the file
    state.file.path.node.body.unshift(
      tailwindConfigImport,
      corePluginsImport,
      tailwindcssinjsImport,
      twConst
    );
  }
}

/**
 * tries to get tailwind config and stores config in state
 * if it fails it stores default config in state
 * @param state
 * @param config
 */
function setTailwindConfigState(
  state: TailwindMacroParamsState,
  config: string
) {
  try {
    state.tailwindConfigPath = resolveTailwindConfigPath(config);
    state.tailwindConfig = requireTailwindConfig(state.tailwindConfigPath);
  } catch (err) {
    state.tailwindConfig = requireTailwindConfig(); //returns default config
  }
}

type TailwindMacroParamsState = {
  configPath: string;
  developmentMode: boolean;
  isDev: boolean;
  tailwindConfigPath?: string;
  tailwindConfig: TailwindConfig;
  tailwind: (arg: TwClasses) => any;
  tailwindDevTwUid: types.Identifier;
  file: any;
};

interface TailwindcssinjsMacroParams extends MacroParams {
  config: {
    config?: string;
    developmentMode?: boolean;
  };
  state: TailwindMacroParamsState;
}

function tailwindcssinjsMacro({
  references: { default: paths },
  state,
  babel: { types: t, template },
  config,
}: TailwindcssinjsMacroParams) {
  try {
    state.configPath = config.config ?? "./tailwind.config.js";
    state.developmentMode = config.developmentMode ?? true;
    state.isDev =
      process.env.NODE_ENV === "development" && state.developmentMode;

    setTailwindConfigState(state, state.configPath);

    if (state.isDev) {
      generateDevCorePlugins();
    } else {
      state.tailwind = tailwindcssinjs(state.tailwindConfig, corePlugins);
    }

    paths.forEach((referencePath) => {
      const args = getArgs(referencePath.parentPath);

      let replacementAst: types.CallExpression | types.Expression;
      if (state.isDev) {
        addDevImports(referencePath, t, state);
        const serialisedArgs = twClassesSerializer(
          state.tailwindConfig?.separator ?? ":"
        )(args);

        replacementAst = t.callExpression(state.tailwindDevTwUid, [
          t.stringLiteral(serialisedArgs),
        ]);
      } else {
        const style = state.tailwind(args);
        replacementAst = template.expression(JSON.stringify(style), {
          placeholderPattern: false,
        })();
      }

      referencePath.parentPath.replaceWith(replacementAst);
    });
  } catch (err) {
    err.message = `@tailwindcssinjs/macro - ${err.message}`;
    throw new MacroError(err);
  }
}

//@ts-expect-error babel-plugin-macros MacroParams type doesn't have config property
export default createMacro(tailwindcssinjsMacro, {
  configName: "tailwindcssinjs",
});
