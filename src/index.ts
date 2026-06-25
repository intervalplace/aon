import fs from "fs/promises";
import path from "path";

import type { AonObject } from "./object.js";

const DATA_DIR = process.env.AON_DATA_DIR ?? "data";
const INDEX_PATH = path.join(DATA_DIR, "index.json");

export type ReferenceIndex = {

    version: 1;

    byHash: Record<string, {

        inbound: string[];

    }>;

    byType: Record<string, string[]>;

    byNamespace: Record<string, string[]>;

};

let index: ReferenceIndex = {

    version: 1,

    byHash: {},

    byType: {},

    byNamespace: {},

};

function lower(x: string) {

    return x.toLowerCase();

}

function uniquePush(
    list: string[],
    value: string
) {

    value = lower(value);

    if (!list.includes(value)) {

        list.push(value);

    }

}

export async function loadIndex() {

    try {

        const raw =
            await fs.readFile(
                INDEX_PATH,
                "utf8"
            );

        index =
            JSON.parse(raw);

    } catch {

        index = {

            version: 1,

            byHash: {},

            byType: {},

            byNamespace: {},

        };

    }

}

export async function saveIndex() {

    await fs.mkdir(
        DATA_DIR,
        {
            recursive: true,
        }
    );

    const tmp =
        `${INDEX_PATH}.tmp-${process.pid}-${Date.now()}`;

    await fs.writeFile(
        tmp,
        JSON.stringify(index, null, 2)
    );

    await fs.rename(
        tmp,
        INDEX_PATH
    );

}

export async function indexObject(
    obj: AonObject
) {

    const hash =
        lower(obj.objectHash);

    //
    // type
    //

    index.byType[obj.objectType] ??= [];

    uniquePush(
        index.byType[obj.objectType],
        hash
    );

    //
    // namespace
    //

    index.byNamespace[obj.namespace] ??= [];

    uniquePush(
        index.byNamespace[obj.namespace],
        hash
    );

    //
    // references
    //

    for (const ref of obj.references) {

        const h =
            lower(ref);

        index.byHash[h] ??= {

            inbound: [],

        };

        uniquePush(
            index.byHash[h].inbound,
            hash
        );

    }

    await saveIndex();

}

export function getIndex() {

    return index;

}

export function inboundReferences(
    hash: string
) {

    return (
        index.byHash[
            lower(hash)
        ]?.inbound ??
        []
    );

}

export function objectsByType(
    type: string
) {

    return (
        index.byType[type] ??
        []
    );

}

export function objectsByNamespace(
    namespace: string
) {

    return (
        index.byNamespace[
            namespace
        ] ??
        []
    );

}
