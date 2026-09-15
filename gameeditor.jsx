import React, { useState, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { Upload, Download, Plus, Trash2, Search, Copy, X, Save, AlertCircle, ChevronRight, ChevronDown, FolderPlus, Pencil, Play, Square } from 'lucide-react';

const ENTITY_TABS = [
	{ key: 'unitTypes', label: 'Units', folderType: 'unit', root: 'units' },
	{ key: 'itemTypes', label: 'Items', folderType: 'item', root: 'items' },
	{ key: 'projectileTypes', label: 'Projectiles', folderType: 'projectile', root: 'projectiles' },
];
const REFERENCE_TABS = [
	{ key: 'attributeTypes', label: 'Attributes' },
	{ key: 'variables', label: 'Variables' },
	{ key: 'sounds', label: 'Sounds' },
	{ key: 'playerTypes', label: 'Player Types' },
];
const GROUP_TABS = [
	{ key: 'unitTypeGroups', label: 'Unit Type Groups', dataType: 'unitTypeGroup', collection: 'unitTypes' },
	{ key: 'itemTypeGroups', label: 'Item Type Groups', dataType: 'itemTypeGroup', collection: 'itemTypes' },
];
const ROOT_NAMES = { units: 'Units', items: 'Items', projectiles: 'Projectiles' };
const TILE_PX = 64; // 1 tile = 64x64 in-game pixels, used as the reference scale for the body size preview

const DEFAULT_UNIT_CONTROLS = {
	movementMethod: 'velocity',
	movementControlScheme: 'wasd',
	movementType: 'wasd',
	mouseBehaviour: { rotateToFaceMouseCursor: true, flipSpriteHorizontallyWRTMouse: false },
	absoluteRotation: false,
	clientPredictedMovement: true,
	permittedInventorySlots: [],
	unitAbilities: {},
	abilities: {},
};

 // 1 tile = 64x64 in-game pixels, used as the reference scale for the body size preview

function generateKey() {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let out = '';
	for (let i = 0; i < 10; i++) out += chars[Math.floor(Math.random() * chars.length)];
	return out;
}

function deepClone(obj) {
	return obj ? JSON.parse(JSON.stringify(obj)) : obj;
}

// ensures every unit/item/projectile has a folders[] placement record (defaulting to that tab's root if missing), and
// that the three root folder nodes exist
// this lets the rest of the app assume every entity is always "filed" somewhere,
// instead of special-casing "this entity predates the folders feature"
function normalizeFolders(parsed) {
	if (!parsed.data.folders) parsed.data.folders = {};
	const folders = parsed.data.folders;

	for (const t of ENTITY_TABS) {
		if (!folders[t.root]) {
			folders[t.root] = { name: ROOT_NAMES[t.root], type: 'folder', closed: false };
		}
	}

	for (const t of ENTITY_TABS) {
		const map = parsed.data[t.key] || {};
		for (const key of Object.keys(map)) {
			if (!folders[key] || folders[key].type === 'folder') {
				folders[key] = { type: t.folderType, parent: t.root, closed: false };
			}
		}
	}

	return parsed;
}

// is `candidateId` the same as `folderId`, or nested somewhere inside it?
// used to stop a group from being moved into its own descendant
function isSelfOrDescendant(folders, folderId, candidateId) {
	let cur = candidateId;
	const seen = new Set();
	while (cur != null) {
		if (cur === folderId) return true;
		if (seen.has(cur)) return false; // guard against any pre-existing cycle
		seen.add(cur);
		cur = folders[cur]?.parent;
	}
	return false;
}

// same idea above
function isSelfOrDescendantScript(scripts, folderId, candidateId) {
	let cur = candidateId;
	const seen = new Set();
	while (cur != null) {
		if (cur === folderId) return true;
		if (seen.has(cur)) return false;
		seen.add(cur);
		cur = scripts[cur]?.parent ?? null;
	}
	return false;
}

function flattenFolderOptions(folders, rootId) {
	const out = [];
	function walk(id, depth) {
		const node = folders[id];
		out.push({ id, depth, name: node?.name || ROOT_NAMES[id] || id });
		Object.entries(folders)
			.filter(([, v]) => v.type === 'folder' && v.parent === id)
			.sort((a, b) => (a[1].name || '').localeCompare(b[1].name || ''))
			.forEach(([childId]) => walk(childId, depth + 1));
	}
	walk(rootId, 0);
	return out;
}

// script treee
// some shit
function resolveIdName(id, gameData) {
	if (typeof id !== 'string' || !gameData?.data) return null;
	const d = gameData.data;
	const lookups = [
		['item', d.itemTypes],
		['unit', d.unitTypes],
		['projectile', d.projectileTypes],
		['attribute', d.attributeTypes],
		['player type', d.playerTypes],
		['script', d.scripts],
		['dialogue', d.dialogues],
		['shop', d.shops],
		['sound', d.sound],
		['music', d.music],
		['particle type', d.particleTypes],
		['state', d.states],
	];
	for (const [kind, coll] of lookups) {
		const hit = coll?.[id];
		if (hit) return { kind, name: hit.name || hit.folderName || id };
	}
	return null;
}

// Which gameData.data collection backs each editable id-picker field kind - used
// both to populate a field's dropdown options and (via resolveIdName above) to
// display a resolved name instead of a raw id anywhere in the tree
const ID_KIND_COLLECTIONS = {
	itemTypeId: 'itemTypes',
	unitTypeId: 'unitTypes',
	projectileTypeId: 'projectileTypes',
	attributeId: 'attributeTypes',
	playerTypeId: 'playerTypes',
	scriptId: 'scripts',
	dialogueId: 'dialogues',
	shopId: 'shops',
	soundId: 'sound',
	musicId: 'music',
	particleTypeId: 'particleTypes',
	stateId: 'states',
};

// "applyForceOnEntityXY" -> "Apply force on entity XY", generic fallback for any
// action/function type name we haven't special-cased below
function readableType(str) {
	if (!str) return '';
	const spaced = str.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
	const words = spaced.split(' ');
	return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w.toLowerCase())).join(' ');
}

const CALC_OPERATORS = { '+': '+', '-': '-', '*': '×', '/': '÷' };

// turns any value node from a script (a literal, or a {function:...} descriptor)
// into a short readable string. Not exhaustive - functions we don't specifically
// know how to phrase fall back to "functionName(...)" with each argument
// described recursively, which stays readable even for functions this doesn't
// have a dedicated phrasing for
function describeValue(val, gameData) {
	if (val === null || val === undefined) return 'nothing';
	if (typeof val === 'boolean') return val ? 'true' : 'false';
	if (typeof val === 'number') return String(val);
	if (typeof val === 'string') {
		const resolved = resolveIdName(val, gameData);
		return resolved ? resolved.name : `"${val}"`;
	}
	if (Array.isArray(val)) return val.map((v) => describeValue(v, gameData)).join(', ');
	if (typeof val !== 'object') return String(val);

	const fn = val.function;
	if (!fn) {
		// a bare {text, entity, key, dataType} style custom-variable reference
		if (val.text) {
			const owner = val.entity ? resolveIdName(val.entity, gameData) : null;
			return owner ? `${val.text} (on ${owner.name})` : val.text;
		}
		return JSON.stringify(val);
	}

	switch (fn) {
		case 'getVariable':
			return val.variableName;
		case 'getTriggeringUnit':
			return 'triggering unit';
		case 'getTriggeringItem':
			return 'triggering item';
		case 'getTriggeringProjectile':
			return 'triggering projectile';
		case 'getLastAttackedUnit':
			return 'last attacked unit';
		case 'getLastAttackingUnit':
			return 'last attacking unit';
		case 'getLastCreatedUnit':
			return 'last created unit';
		case 'thisEntity':
			return 'this entity';
		case 'getSelectedEntity':
			return 'selected entity';
		case 'undefinedValue':
			return 'nothing';
		case 'getOwnerOfItem':
			return `owner of ${describeValue(val.entity, gameData)}`;
		case 'getOwner':
			return `owner of ${describeValue(val.entity, gameData)}`;
		case 'getItemTypeOfItem':
			return `item type of ${describeValue(val.entity, gameData)}`;
		case 'getUnitTypeOfUnit':
			return `unit type of ${describeValue(val.entity, gameData)}`;
		case 'getItemTypeName':
			return `name of ${describeValue(val.itemType, gameData)}`;
		case 'getEntityAttribute':
			return `${describeValue(val.attribute, gameData)} of ${describeValue(val.entity, gameData)}`;
		case 'entityAttributeMax':
			return `max ${describeValue(val.attribute, gameData)} of ${describeValue(val.entity, gameData)}`;
		case 'getValueOfEntityVariable':
			return `${describeValue(val.variable, gameData)} of ${describeValue(val.entity, gameData)}`;
		case 'getEntityVariable':
			return describeValue(val.variable, gameData);
		case 'playerTypeOfPlayer':
			return `player type of ${describeValue(val.player, gameData)}`;
		case 'playersAreHostile':
			return `${describeValue(val.playerA, gameData)} hostile to ${describeValue(val.playerB, gameData)}`;
		case 'getEntityPosition':
			return `position of ${describeValue(val.entity, gameData)}`;
		case 'getPositionX':
			return `x of ${describeValue(val.position, gameData)}`;
		case 'getPositionY':
			return `y of ${describeValue(val.position, gameData)}`;
		case 'xyCoordinate':
			return `(${describeValue(val.x, gameData)}, ${describeValue(val.y, gameData)})`;
		case 'toRadians':
			return `${describeValue(val.number, gameData)} degrees`;
		case 'angleBetweenPositions':
			return `angle from ${describeValue(val.positionA, gameData)} to ${describeValue(val.positionB, gameData)}`;
		case 'getMin':
			return `min(${describeValue(val.num1, gameData)}, ${describeValue(val.num2, gameData)})`;
		case 'getMax':
			return `max(${describeValue(val.num1, gameData)}, ${describeValue(val.num2, gameData)})`;
		case 'stringToNumber':
		case 'numberToString':
			return describeValue(val.value, gameData);
		case 'getStringArrayElement':
			return `${describeValue(val.string, gameData)}[${describeValue(val.number, gameData)}]`;
		case 'getStringArrayLength':
			return `length of ${describeValue(val.string, gameData)}`;
		case 'updateStringArrayElement':
			return `${describeValue(val.string, gameData)} with [${describeValue(val.number, gameData)}] set to ${describeValue(val.value, gameData)}`;
		case 'unitIsCarryingItemType':
			return `${describeValue(val.unit, gameData)} carrying ${describeValue(val.itemType, gameData)}`;
		case 'getItemAtSlot':
			return `item in slot ${describeValue(val.slot, gameData)} of ${describeValue(val.unit, gameData)}`;
		case 'getUnitFromId':
			return `unit #${describeValue(val.string, gameData)}`;
		case 'entitiesBetweenTwoPositions':
			return `entities between ${describeValue(val.positionA, gameData)} and ${describeValue(val.positionB, gameData)}`;
		case 'calculate': {
			const [opDesc, a, b] = val.items || [];
			const op = CALC_OPERATORS[opDesc?.operator] || opDesc?.operator || '?';
			return `(${describeValue(a, gameData)} ${op} ${describeValue(b, gameData)})`;
		}
		default: {
			const args = Object.entries(val)
				.filter(([k]) => k !== 'function')
				.map(([k, v]) => `${k}: ${describeValue(v, gameData)}`)
				.join(', ');
			return `${readableType(fn)}(${args})`;
		}
	}
}

// The weird-but-consistent [ {operator,operandType}, operandA, operandB ] triple
// used for every condition in this schema, including the "OR of triples" case.
function describeCondition(cond, gameData) {
	if (Array.isArray(cond) && cond.length === 3 && cond[0]?.operator) {
		const [desc, a, b] = cond;
		if (desc.operandType === 'or' || desc.operator === 'OR') {
			return (a || []).map((sub) => describeCondition(sub, gameData)).join(' OR ');
		}
		return `${describeValue(a, gameData)} ${desc.operator} ${describeValue(b, gameData)}`;
	}
	return describeValue(cond, gameData);
}

const SCRIPT_NODE_COLORS = {
	trigger: '#5DCAA5',
	condition: '#85B7EB',
	action: '#F0997B',
	variable: '#AFA9EC',
	control: '#8291A1',
	script: '#ED93B1',
};

// a handful of common param keys worth surfacing inline for actions this viewer
// doesn't have a dedicated phrasing for (see the default case below) - covers
// most of the action types in this engine well enough to be readable even
// without a bespoke line for every single one
const GENERIC_ACTION_PARAM_KEYS = ['entity', 'unit', 'attribute', 'variable', 'variableName', 'value', 'force', 'angle', 'unitType', 'itemType', 'scale', 'slot'];

// data-driven field schemas, generated from real usage across an actual shipped
// game's scripts (not guessed from memory) - for each action type, which top-level
// keys are worth exposing as editable fields, and what kind of value each holds,
// only covers action types that showed up in that real data; anything else still
// gets full structural editing (delete/duplicate/disable/reorder) plus the
// generic read-only summary line, it just won't have a dedicated fields panel
const ACTION_FIELD_SCHEMAS = {
	addAttributeBuffToUnit: [{ key: 'attribute', kind: 'attributeId' }, { key: 'entity', kind: 'valueExpr' }, { key: 'time', kind: 'number' }, { key: 'value', kind: 'valueExpr' }],
	aiAttackUnit: [{ key: 'targetUnit', kind: 'valueExpr' }, { key: 'unit', kind: 'valueExpr' }],
	aiGoIdle: [{ key: 'unit', kind: 'valueExpr' }],
	aiMoveToPosition: [{ key: 'position', kind: 'valueExpr' }, { key: 'unit', kind: 'valueExpr' }],
	applyForceOnEntityAngle: [{ key: 'angle', kind: 'valueExpr' }, { key: 'entity', kind: 'valueExpr' }, { key: 'force', kind: 'number' }],
	applyForceOnEntityXY: [{ key: 'entity', kind: 'valueExpr' }, { key: 'force', kind: 'xy' }],
	assignPlayerType: [{ key: 'entity', kind: 'valueExpr' }, { key: 'playerType', kind: 'playerTypeId' }],
	changeScaleOfEntityBody: [{ key: 'entity', kind: 'valueExpr' }, { key: 'scale', kind: 'valueExpr' }],
	changeUnitType: [{ key: 'entity', kind: 'valueExpr' }, { key: 'unitType', kind: 'unitTypeId' }],
	closeDialogueForPlayer: [{ key: 'player', kind: 'valueExpr' }],
	closeShopForPlayer: [{ key: 'player', kind: 'valueExpr' }],
	createEntityForPlayerAtPositionWithDimensions: [{ key: 'actionId', kind: 'string' }, { key: 'angle', kind: 'valueExpr' }, { key: 'entity', kind: 'unitTypeId' }, { key: 'entityType', kind: 'string' }, { key: 'height', kind: 'valueExpr' }, { key: 'player', kind: 'valueExpr' }, { key: 'position', kind: 'valueExpr' }, { key: 'width', kind: 'valueExpr' }],
	createFloatingText: [{ key: 'color', kind: 'string' }, { key: 'position', kind: 'valueExpr' }, { key: 'text', kind: 'valueExpr' }],
	createProjectileAtPosition: [{ key: 'actionId', kind: 'string' }, { key: 'angle', kind: 'valueExpr' }, { key: 'force', kind: 'valueExpr' }, { key: 'position', kind: 'valueExpr' }, { key: 'projectileType', kind: 'valueExpr' }, { key: 'unit', kind: 'valueExpr' }],
	createUnitAtPosition: [{ key: 'actionId', kind: 'string' }, { key: 'angle', kind: 'valueExpr' }, { key: 'entity', kind: 'valueExpr' }, { key: 'position', kind: 'valueExpr' }, { key: 'runMode', kind: 'number' }, { key: 'unitType', kind: 'valueExpr' }],
	decreaseVariableByNumber: [{ key: 'number', kind: 'valueExpr' }, { key: 'variable', kind: 'string' }],
	destroyEntity: [{ key: 'entity', kind: 'valueExpr' }, { key: 'runOnClient', kind: 'boolean' }],
	disableAI: [{ key: 'unit', kind: 'valueExpr' }],
	editMapTile: [{ key: 'gid', kind: 'valueExpr' }, { key: 'layer', kind: 'valueExpr' }, { key: 'runMode', kind: 'number' }, { key: 'x', kind: 'valueExpr' }, { key: 'y', kind: 'valueExpr' }],
	emitParticlesAtPosition: [{ key: 'angle', kind: 'number' }, { key: 'particleType', kind: 'particleTypeId' }, { key: 'position', kind: 'valueExpr' }, { key: 'runMode', kind: 'number' }],
	enableAI: [{ key: 'unit', kind: 'valueExpr' }],
	giveNewItemToUnit: [{ key: 'itemType', kind: 'itemTypeId' }, { key: 'unit', kind: 'valueExpr' }],
	hideUiElementForPlayer: [{ key: 'elementId', kind: 'string' }, { key: 'player', kind: 'valueExpr' }],
	hideUiTextForEveryone: [{ key: 'target', kind: 'string' }],
	hideUnitFromPlayer: [{ key: 'entity', kind: 'valueExpr' }, { key: 'player', kind: 'valueExpr' }],
	increaseVariableByNumber: [{ key: 'number', kind: 'valueExpr' }, { key: 'runMode', kind: 'number' }, { key: 'variable', kind: 'string' }],
	kickPlayer: [{ key: 'entity', kind: 'valueExpr' }, { key: 'message', kind: 'string' }, { key: 'vars', kind: 'valueExpr' }],
	loadPlayerDataAndApplyIt: [{ key: 'player', kind: 'valueExpr' }, { key: 'unit', kind: 'valueExpr' }],
	loadPlayerDataFromString: [{ key: 'player', kind: 'valueExpr' }, { key: 'string', kind: 'valueExpr' }],
	loadUnitDataFromString: [{ key: 'string', kind: 'valueExpr' }, { key: 'unit', kind: 'valueExpr' }],
	makeUnitInvisible: [{ key: 'entity', kind: 'valueExpr' }],
	moveEntity: [{ key: 'actionId', kind: 'string' }, { key: 'entity', kind: 'valueExpr' }, { key: 'position', kind: 'valueExpr' }],
	openDialogueForPlayer: [{ key: 'dialogue', kind: 'dialogueId' }, { key: 'player', kind: 'valueExpr' }, { key: 'vars', kind: 'valueExpr' }],
	openShopForPlayer: [{ key: 'player', kind: 'valueExpr' }, { key: 'shop', kind: 'shopId' }, { key: 'vars', kind: 'valueExpr' }],
	openWebsiteForPlayer: [{ key: 'player', kind: 'valueExpr' }, { key: 'string', kind: 'string' }, { key: 'vars', kind: 'valueExpr' }],
	playEntityAnimation: [{ key: 'animation', kind: 'string' }, { key: 'entity', kind: 'valueExpr' }],
	playMusic: [{ key: 'music', kind: 'musicId' }],
	playMusicForPlayerRepeatedly: [{ key: 'music', kind: 'musicId' }, { key: 'player', kind: 'valueExpr' }],
	playSoundAtPosition: [{ key: 'position', kind: 'valueExpr' }, { key: 'sound', kind: 'soundId' }],
	playSoundForPlayer: [{ key: 'player', kind: 'valueExpr' }, { key: 'sound', kind: 'soundId' }],
	playerCameraSetZoom: [{ key: 'player', kind: 'valueExpr' }, { key: 'zoom', kind: 'number' }],
	playerCameraTrackUnit: [{ key: 'fighter', kind: 'valueExpr' }, { key: 'player', kind: 'valueExpr' }, { key: 'unit', kind: 'valueExpr' }],
	positionCamera: [{ key: 'player', kind: 'valueExpr' }, { key: 'position', kind: 'valueExpr' }],
	rotateEntityToRadiansLT: [{ key: 'entity', kind: 'valueExpr' }, { key: 'radians', kind: 'valueExpr' }],
	savePlayerData: [{ key: 'player', kind: 'valueExpr' }],
	sendChatMessage: [{ key: 'message', kind: 'valueExpr' }, { key: 'runMode', kind: 'number' }, { key: 'vars', kind: 'valueExpr' }],
	sendChatMessageToPlayer: [{ key: 'message', kind: 'valueExpr' }, { key: 'player', kind: 'valueExpr' }, { key: 'runMode', kind: 'number' }, { key: 'vars', kind: 'valueExpr' }],
	sendPostRequest: [{ key: 'string', kind: 'valueExpr' }, { key: 'url', kind: 'string' }, { key: 'varName', kind: 'string' }, { key: 'vars', kind: 'valueExpr' }],
	setEntityAttribute: [{ key: 'attribute', kind: 'attributeId' }, { key: 'entity', kind: 'valueExpr' }, { key: 'value', kind: 'valueExpr' }],
	setEntityAttributeMax: [{ key: 'attribute', kind: 'attributeId' }, { key: 'entity', kind: 'valueExpr' }, { key: 'value', kind: 'valueExpr' }],
	setEntityAttributeMin: [{ key: 'attribute', kind: 'attributeId' }, { key: 'entity', kind: 'valueExpr' }, { key: 'value', kind: 'valueExpr' }],
	setEntityAttributeRegenerationRate: [{ key: 'attribute', kind: 'attributeId' }, { key: 'entity', kind: 'valueExpr' }, { key: 'value', kind: 'valueExpr' }],
	setEntityLifeSpan: [{ key: 'entity', kind: 'valueExpr' }, { key: 'lifeSpan', kind: 'number' }],
	setEntityState: [{ key: 'entity', kind: 'valueExpr' }, { key: 'state', kind: 'stateId' }],
	setEntityVelocityAtAngle: [{ key: 'angle', kind: 'valueExpr' }, { key: 'entity', kind: 'valueExpr' }, { key: 'speed', kind: 'valueExpr' }],
	setFadingTextOfUnit: [{ key: 'color', kind: 'string' }, { key: 'text', kind: 'valueExpr' }, { key: 'unit', kind: 'valueExpr' }],
	setItemFireRate: [{ key: 'item', kind: 'valueExpr' }, { key: 'number', kind: 'valueExpr' }],
	setLastAttackedUnit: [{ key: 'unit', kind: 'valueExpr' }],
	setLastAttackingUnit: [{ key: 'unit', kind: 'valueExpr' }],
	setMaxAttackRange: [{ key: 'number', kind: 'number' }, { key: 'unit', kind: 'valueExpr' }],
	setOwnerUnitOfProjectile: [{ key: 'projectile', kind: 'valueExpr' }, { key: 'unit', kind: 'valueExpr' }],
	setPlayerAttribute: [{ key: 'attribute', kind: 'attributeId' }, { key: 'entity', kind: 'valueExpr' }, { key: 'value', kind: 'valueExpr' }, { key: 'vars', kind: 'valueExpr' }],
	setPlayerAttributeMax: [{ key: 'attributeType', kind: 'attributeId' }, { key: 'number', kind: 'valueExpr' }, { key: 'player', kind: 'valueExpr' }],
	setPlayerName: [{ key: 'name', kind: 'valueExpr' }, { key: 'player', kind: 'valueExpr' }],
	setPlayerVariable: [{ key: 'player', kind: 'valueExpr' }, { key: 'value', kind: 'valueExpr' }, { key: 'variable', kind: 'valueExpr' }],
	setSourceItemOfProjectile: [{ key: 'item', kind: 'valueExpr' }, { key: 'projectile', kind: 'valueExpr' }],
	setTimeOut: [{ key: 'duration', kind: 'valueExpr' }, { key: 'runMode', kind: 'number' }, { key: 'vars', kind: 'valueExpr' }],
	setUnitNameLabel: [{ key: 'name', kind: 'valueExpr' }, { key: 'unit', kind: 'valueExpr' }],
	setVelocityOfEntityXY: [{ key: 'entity', kind: 'valueExpr' }, { key: 'velocity', kind: 'xy' }],
	showCustomModalToPlayer: [{ key: 'htmlContent', kind: 'valueExpr' }, { key: 'player', kind: 'valueExpr' }, { key: 'runMode', kind: 'number' }],
	showInputModalToPlayer: [{ key: 'inputLabel', kind: 'valueExpr' }, { key: 'player', kind: 'valueExpr' }],
	showUiElementForPlayer: [{ key: 'elementId', kind: 'string' }, { key: 'player', kind: 'valueExpr' }],
	showUiTextForEveryone: [{ key: 'target', kind: 'string' }],
	showUiTextForPlayer: [{ key: 'entity', kind: 'valueExpr' }, { key: 'target', kind: 'string' }],
	showUnitToPlayer: [{ key: 'entity', kind: 'valueExpr' }, { key: 'player', kind: 'valueExpr' }],
	spawnItem: [{ key: 'actionId', kind: 'string' }, { key: 'itemType', kind: 'valueExpr' }, { key: 'position', kind: 'valueExpr' }],
	stopMusicForPlayer: [{ key: 'player', kind: 'valueExpr' }],
	stunUnit: [{ key: 'unit', kind: 'valueExpr' }],
	transformRegionDimensions: [{ key: 'height', kind: 'valueExpr' }, { key: 'region', kind: 'valueExpr' }, { key: 'width', kind: 'valueExpr' }, { key: 'x', kind: 'valueExpr' }, { key: 'y', kind: 'valueExpr' }],
	updateUiTextForPlayer: [{ key: 'entity', kind: 'valueExpr' }, { key: 'target', kind: 'string' }, { key: 'value', kind: 'valueExpr' }],
	updateUiTextForTimeForPlayer: [{ key: 'player', kind: 'valueExpr' }, { key: 'target', kind: 'string' }, { key: 'time', kind: 'number' }, { key: 'value', kind: 'valueExpr' }],
	useItemOnce: [{ key: 'item', kind: 'valueExpr' }],
};

// generic path-based mutator for the whole editable tree - path is an array of
// keys/indices from the script root (e.g. ['actions', 2, 'then', 0, 'force', 'x']),
// every structural op (delete/duplicate/move/disable) and every field edit routes
// through this one function, which is what keeps the editing UI itself simple:
// every node just needs to know its own path, not how to mutate the tree
function applyScriptOp(script, path, operation, payload) {
	const next = deepClone(script);
	const parentPath = path.slice(0, -1);
	const lastKey = path[path.length - 1];
	let parent = next;
	for (const k of parentPath) parent = parent?.[k];
	if (parent == null) return next;

	if (operation === 'setField') {
		parent[lastKey] = payload;
	} else if (operation === 'insert') {
		const list = getAtPath(next, path);
		if (Array.isArray(list) && payload?.value) list.splice(Math.max(0, Math.min(payload.index ?? list.length, list.length)), 0, deepClone(payload.value));
	} else if (operation === 'toggleDisabled') {
		const node = parent[lastKey];
		if (node) node.disabled = !node.disabled;
	} else if (operation === 'delete' && Array.isArray(parent)) {
		parent.splice(lastKey, 1);
	} else if (operation === 'duplicate' && Array.isArray(parent)) {
		parent.splice(lastKey + 1, 0, deepClone(parent[lastKey]));
	} else if (operation === 'moveUp' && Array.isArray(parent) && lastKey > 0) {
		[parent[lastKey - 1], parent[lastKey]] = [parent[lastKey], parent[lastKey - 1]];
	} else if (operation === 'moveDown' && Array.isArray(parent) && lastKey < parent.length - 1) {
		[parent[lastKey + 1], parent[lastKey]] = [parent[lastKey], parent[lastKey + 1]];
	}
	return next;
}

// renders one editable field per the field's `kind`. only handles plain-literal
// values directly (a number, a string, a boolean, a known id, or a bare {x,y}
// pair) - anything more complex (a nested function-call expression) is shown via
// the same read-only describeValue() text used elsewhere in the tree, with a note
// pointing at Raw JSON, rather than trying to build an editor for arbitrary
// expression trees

function getAtPath(root, path) {
	let value = root;
	for (const k of path || []) value = value?.[k];
	return value;
}

function defaultValueForScriptField(kind) {
	switch (kind) {
		case 'boolean': return false;
		case 'number': return 0;
		case 'xy': return { x: 0, y: 0 };
		case 'string': return '';
		case 'valueExpr': return 0;
		case 'itemTypeId': case 'unitTypeId': case 'projectileTypeId': case 'attributeId':
		case 'playerTypeId': case 'scriptId': case 'dialogueId': case 'shopId': case 'soundId':
		case 'musicId': case 'particleTypeId': case 'stateId': return '';
		default: return null;
	}
}

const SCRIPT_CONTAINER_ACTION_TYPES = new Set(['for', 'repeat', 'while', 'forAllUnits', 'forAllItems', 'forAllPlayers', 'forAllEntities', 'forAllUnitTypes', 'forAllItemTypes', 'forAllProjectiles', 'forAllRegions']);

function defaultActionForType(type) {
	if (type === 'condition') return { type: 'condition', conditions: [{ operandType: 'boolean', operator: '==' }, true, true], then: [], else: [] };
	if (type === 'runScript') return { type: 'runScript', scriptName: '', isEntityScript: false };
	const schema = ACTION_FIELD_SCHEMAS[type];
	if (schema) {
		const out = { type };
		for (const field of schema) out[field.key] = defaultValueForScriptField(field.kind);
		if (SCRIPT_CONTAINER_ACTION_TYPES.has(type)) out.actions = [];
		return out;
	}
	if (SCRIPT_CONTAINER_ACTION_TYPES.has(type)) return { type, actions: [] };
	return { type };
}

const FALLBACK_TRIGGER_TYPES = ['gameStart', 'secondTick', 'playerJoinsGame', 'playerLeavesGame', 'playerSendsChatMessage', 'playerCustomInput', 'unitUsesItem', 'unitTouchesUnit', 'unitTouchesItem', 'unitTouchesProjectile', 'unitAttacksUnit', 'unitEntersRegion', 'unitAttributeBecomesZero', 'playerPurchasesUnit', 'htmlUiClick'];
const FALLBACK_CONDITION_OPERATORS = ['==', '!=', '>', '<', '>=', '<=', 'AND', 'OR'];
const FALLBACK_OPERAND_TYPES = ['boolean', 'number', 'string', 'player', 'unit', 'item', 'projectile', 'unitType', 'attribute'];

function collectScriptVocabulary(gameData) {
	const scripts = gameData?.data?.scripts || {};
	const triggerTypes = new Set(FALLBACK_TRIGGER_TYPES);
	const actionTypes = new Set(Object.keys(ACTION_FIELD_SCHEMAS));
	const conditionOperators = new Set(FALLBACK_CONDITION_OPERATORS);
	const operandTypes = new Set(FALLBACK_OPERAND_TYPES);
	function walk(value) {
		if (Array.isArray(value)) return value.forEach(walk);
		if (!value || typeof value !== 'object') return;
		if (value.type && value.type !== 'condition') actionTypes.add(value.type);
		if (value.type === 'condition' && Array.isArray(value.conditions) && value.conditions[0]) {
			if (value.conditions[0].operator) conditionOperators.add(value.conditions[0].operator);
			if (value.conditions[0].operandType) operandTypes.add(value.conditions[0].operandType);
		}
		Object.values(value).forEach(walk);
	}
	Object.values(scripts).forEach((script) => {
		(script?.triggers || []).forEach((t) => { if (t?.type) triggerTypes.add(t.type); });
		walk(script?.actions);
		if (Array.isArray(script?.conditions) && script.conditions[0]) {
			if (script.conditions[0].operator) conditionOperators.add(script.conditions[0].operator);
			if (script.conditions[0].operandType) operandTypes.add(script.conditions[0].operandType);
		}
	});
	return { triggers: [...triggerTypes].sort((a,b) => readableType(a).localeCompare(readableType(b))), actions: [...actionTypes].sort((a,b) => readableType(a).localeCompare(readableType(b))), operators: [...conditionOperators].sort(), operandTypes: [...operandTypes].sort() };
}

function ScriptConditionEditor({ value, gameData, onChange }) {
	const vocab = collectScriptVocabulary(gameData);
	const cond = Array.isArray(value) && value.length >= 3 && value[0] && typeof value[0] === 'object' ? value : [{ operandType: 'boolean', operator: '==' }, true, true];
	const meta = cond[0] || {};
	return (
		<div className="w-full bg-[#262e36]/70 border border-[#3d4a57] rounded-md p-2 space-y-2">
			<div className="flex flex-wrap items-center gap-2">
				<select value={meta.operandType || 'boolean'} onChange={(e) => onChange([{ ...meta, operandType: e.target.value }, cond[1], cond[2]])} className="bg-[#323d48] border border-[#48596a] rounded px-1.5 py-1 text-xs">{vocab.operandTypes.map((x) => <option key={x} value={x}>{x}</option>)}</select>
				<select value={meta.operator || '=='} onChange={(e) => onChange([{ ...meta, operator: e.target.value }, cond[1], cond[2]])} className="bg-[#323d48] border border-[#48596a] rounded px-1.5 py-1 text-xs">{vocab.operators.map((x) => <option key={x} value={x}>{x}</option>)}</select>
			</div>
			<div className="grid grid-cols-[auto_1fr] items-start gap-x-2 gap-y-1">
				<span className="text-[10px] text-[#8291a1] pt-1">left</span><ScriptValueEditor value={cond[1]} gameData={gameData} onChange={(v) => onChange([cond[0], v, cond[2]])} />
				<span className="text-[10px] text-[#8291a1] pt-1">right</span><ScriptValueEditor value={cond[2]} gameData={gameData} onChange={(v) => onChange([cond[0], cond[1], v])} />
			</div>
		</div>
	);
}

function ScriptAddMenu({ label, options, onSelect }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="relative inline-block">
			<button type="button" onClick={() => setOpen((v) => !v)} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-dashed border-[#48596a] text-xs text-[#a3adb8] hover:border-[#1a56da] hover:text-[#1a56da]"><Plus size={13} /> {label}</button>
			{open && <div className="absolute z-30 mt-1 left-0 min-w-64 max-h-72 overflow-y-auto bg-[#262e36] border border-[#48596a] rounded-md shadow-xl p-1">{options.map((option) => <button key={option.value} type="button" onClick={() => { setOpen(false); onSelect(option.value); }} className="w-full text-left px-2 py-1.5 rounded text-xs text-[#c5ccd3] hover:bg-[#323d48]">{option.label}</button>)}</div>}
		</div>
	);
}

function ScriptValueEditor({ value, gameData, onChange, depth = 0 }) {
	const [open, setOpen] = useState(depth < 1);

	if (value === null) return <span className="text-xs text-[#8291a1] italic">null</span>;
	if (typeof value === 'boolean') return <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} className="accent-[#1a56da]" />;
	if (typeof value === 'number') return <input type="number" value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-28 bg-[#262e36] border border-[#3d4a57] rounded px-1.5 py-0.5 text-xs focus:outline-none focus:border-[#1a56da]" />;
	if (typeof value === 'string') return <input type="text" value={value} onChange={(e) => onChange(e.target.value)} className="w-44 bg-[#262e36] border border-[#3d4a57] rounded px-1.5 py-0.5 text-xs focus:outline-none focus:border-[#1a56da]" />;
	if (Array.isArray(value)) {
		return (
			<div className="w-full">
				<button type="button" onClick={() => setOpen((o) => !o)} className="flex items-center gap-1 text-xs text-[#a3adb8] hover:text-[#e1e6ea]">
					{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}<span className="font-mono">Array [{value.length}]</span>
				</button>
				{open && <div className="ml-3 mt-1 border-l border-[#48596a] pl-2 space-y-1">
					{value.map((item, index) => <div key={index} className="flex items-start gap-1.5">
						<span className="text-[10px] text-[#637588] font-mono w-5 pt-1 shrink-0">{index}</span>
						<div className="flex-1 min-w-0"><ScriptValueEditor value={item} gameData={gameData} depth={depth + 1} onChange={(next) => { const copy = value.slice(); copy[index] = next; onChange(copy); }} /></div>
						<button type="button" title="Remove array entry" onClick={() => onChange(value.filter((_, i) => i !== index))} className="p-1 text-[#637588] hover:text-red-400 shrink-0"><X size={11} /></button>
					</div>)}
					<button type="button" onClick={() => onChange([...value, null])} className="text-[10px] text-[#637588] hover:text-[#1a56da]">+ Add value</button>
				</div>}
			</div>
		);
	}
	if (typeof value === 'object') {
		const objectTitle = value.function || value.type || 'Object';
		const keys = Object.keys(value);
		return (
			<div className="w-full">
				<button type="button" onClick={() => setOpen((o) => !o)} className="flex items-center gap-1 text-xs text-[#a3adb8] hover:text-[#e1e6ea]">
					{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}<span className="font-mono">{objectTitle}</span><span className="text-[10px] text-[#637588]">{keys.length} field{keys.length === 1 ? '' : 's'}</span>
				</button>
				{open && <div className="ml-3 mt-1 border-l border-[#48596a] pl-2 space-y-1.5">
					{keys.map((key) => <div key={key} className="flex items-start gap-2">
						<span className="text-[10px] text-[#8291a1] font-mono w-24 shrink-0 pt-1 truncate" title={key}>{key}</span>
						<div className="flex-1 min-w-0"><ScriptValueEditor value={value[key]} gameData={gameData} depth={depth + 1} onChange={(next) => onChange({ ...value, [key]: next })} /></div>
						<button type="button" title={`Remove ${key}`} onClick={() => { const copy = { ...value }; delete copy[key]; onChange(copy); }} className="p-1 text-[#637588] hover:text-red-400 shrink-0"><X size={11} /></button>
					</div>)}
				</div>}
			</div>
		);
	}
	return <span className="text-xs text-[#8291a1] italic">{String(value)}</span>;
}

function ScriptFieldInput({ kind, value, gameData, onChange }) {
	const collectionKey = ID_KIND_COLLECTIONS[kind];
	if (collectionKey) {
		const options = Object.entries(gameData?.data?.[collectionKey] || {})
			.map(([id, v]) => ({ id, name: v.name || v.folderName || id }))
			.sort((a, b) => a.name.localeCompare(b.name));
		if (typeof value === 'object' && value !== null) {
			return <ScriptValueEditor value={value} gameData={gameData} onChange={onChange} />;
		}
		return (
			<select
				value={value ?? ''}
				onChange={(e) => onChange(e.target.value)}
				className="bg-[#262e36] border border-[#3d4a57] rounded px-1.5 py-0.5 text-xs focus:outline-none focus:border-[#1a56da]"
			>
				<option value="">(none)</option>
				{options.map((o) => (
					<option key={o.id} value={o.id}>
						{o.name}
					</option>
				))}
			</select>
		);
	}
	if (kind === 'xy') {
		if (typeof value !== 'object' || value === null || typeof value.x !== 'number' || typeof value.y !== 'number') {
			return <ScriptValueEditor value={value} gameData={gameData} onChange={onChange} />;
		}
		return (
			<span className="flex items-center gap-1">
				<span className="text-[10px] text-[#637588]">x</span>
				<input
					type="number"
					value={value.x}
					onChange={(e) => onChange({ ...value, x: Number(e.target.value) })}
					className="w-20 bg-[#262e36] border border-[#3d4a57] rounded px-1.5 py-0.5 text-xs focus:outline-none focus:border-[#1a56da]"
				/>
				<span className="text-[10px] text-[#637588]">y</span>
				<input
					type="number"
					value={value.y}
					onChange={(e) => onChange({ ...value, y: Number(e.target.value) })}
					className="w-20 bg-[#262e36] border border-[#3d4a57] rounded px-1.5 py-0.5 text-xs focus:outline-none focus:border-[#1a56da]"
				/>
			</span>
		);
	}
	if (kind === 'boolean') {
		if (typeof value !== 'boolean') {
			return <ScriptValueEditor value={value} gameData={gameData} onChange={onChange} />;
		}
		return (
			<input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} className="accent-[#1a56da]" />
		);
	}
	if (kind === 'number') {
		if (typeof value !== 'number') {
			return <ScriptValueEditor value={value} gameData={gameData} onChange={onChange} />;
		}
		return (
			<input
				type="number"
				value={value}
				onChange={(e) => onChange(Number(e.target.value))}
				className="w-24 bg-[#262e36] border border-[#3d4a57] rounded px-1.5 py-0.5 text-xs focus:outline-none focus:border-[#1a56da]"
			/>
		);
	}
	if (kind === 'string') {
		if (typeof value !== 'string') {
			return <ScriptValueEditor value={value} gameData={gameData} onChange={onChange} />;
		}
		return (
			<input
				type="text"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				className="w-40 bg-[#262e36] border border-[#3d4a57] rounded px-1.5 py-0.5 text-xs focus:outline-none focus:border-[#1a56da]"
			/>
		);
	}
	// 'valueExpr' (or any kind we don't have a widget for): editable only when the
	// current value happens to be a plain literal right now; a real expression
	// (getVariable, calculate, etc.) stays read-only.
	if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
		return <ScriptFieldInput kind={typeof value} value={value} gameData={gameData} onChange={onChange} />;
	}
	return <ScriptValueEditor value={value} gameData={gameData} onChange={onChange} />;
}


function ScriptActionNode({ action, gameData, depth, onJumpToScript, path, onOp, siblingCount, indexInParent }) {
	const [open, setOpen] = useState(depth < 2);
	const [fieldsOpen, setFieldsOpen] = useState(false);
	if (!action || typeof action !== 'object') return null;

	let color = SCRIPT_NODE_COLORS.action;
	let label;
	let children = null; // array of { heading, actions, basePath } sections to render nested, collapsible

	if (action.type === 'condition') {
		color = SCRIPT_NODE_COLORS.condition;
		label = `if ${describeCondition(action.conditions, gameData)}`;
		children = [{ heading: null, actions: action.then || [], basePath: [...path, 'then'] }];
		if (action.else && action.else.length) children.push({ heading: 'else', actions: action.else, basePath: [...path, 'else'] });
	} else if (action.type === 'runScript') {
		color = SCRIPT_NODE_COLORS.script;
		const target = resolveIdName(action.scriptName, gameData);
		label = `run script: ${target ? target.name : action.scriptName}`;
	} else if (action.type === 'setVariable') {
		color = SCRIPT_NODE_COLORS.variable;
		label = `${action.variableName} = ${describeValue(action.value, gameData)}`;
	} else if (action.type === 'setEntityVariable') {
		color = SCRIPT_NODE_COLORS.variable;
		label = `${describeValue(action.variable, gameData)} of ${describeValue(action.entity, gameData)} = ${describeValue(action.value, gameData)}`;
	} else if (action.type === 'return' || action.type === 'break' || action.type === 'continue') {
		color = SCRIPT_NODE_COLORS.control;
		label = readableType(action.type);
	} else if (Array.isArray(action.actions)) {
		// loop-shaped action (for, forAllEntities, forAllPlayers, etc.)
		color = SCRIPT_NODE_COLORS.control;
		const rangeBit =
			action.entityGroup !== undefined
				? ` over ${describeValue(action.entityGroup, gameData)}`
				: action.start !== undefined
					? ` (${action.variableName} from ${describeValue(action.start, gameData)} to ${describeValue(action.stop, gameData)})`
					: '';
		label = `${readableType(action.type)}${rangeBit}`;
		children = [{ heading: null, actions: action.actions, basePath: [...path, 'actions'] }];
	} else {
		const parts = GENERIC_ACTION_PARAM_KEYS.filter((k) => action[k] !== undefined).map(
			(k) => `${k}: ${describeValue(action[k], gameData)}`
		);
		label = `${readableType(action.type || 'unknown action')}${parts.length ? ' — ' + parts.join(', ') : ''}`;
	}

	const hasChildren = !!children;
	const fieldSchema = action.type === 'condition' ? null : ACTION_FIELD_SCHEMAS[action.type];
	const canMoveUp = indexInParent > 0;
	const canMoveDown = indexInParent < siblingCount - 1;

	return (
		<div style={{ marginLeft: depth * 16 }}>
			<div className="flex items-center gap-1.5 py-1 px-1.5 rounded hover:bg-[#323d48]/60 group">
				<span
					className="flex items-center gap-1.5 flex-1 min-w-0"
					style={{ cursor: hasChildren || action.type === 'runScript' ? 'pointer' : 'default' }}
					onClick={() => {
						if (hasChildren) setOpen((o) => !o);
						else if (action.type === 'runScript' && onJumpToScript) onJumpToScript(action.scriptName);
					}}
				>
					<span style={{ width: 7, height: 7, borderRadius: 2, background: color, flexShrink: 0 }} />
					{hasChildren ? (
						open ? <ChevronDown size={13} className="text-[#637588] shrink-0" /> : <ChevronRight size={13} className="text-[#637588] shrink-0" />
					) : (
						<span style={{ width: 13, display: 'inline-block', flexShrink: 0 }} />
					)}
					<span className={`text-xs font-mono truncate ${action.disabled ? 'line-through text-[#637588]' : 'text-[#c5ccd3]'}`}>{label}</span>
					{action.disabled && (
						<span className="text-[10px] text-red-400 border border-red-900 rounded px-1 shrink-0">disabled</span>
					)}
					{action.type === 'runScript' && <ExternalLinkIcon />}
				</span>
				{onOp && (
					<span className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
						{((fieldSchema && fieldSchema.length > 0) || action.type === 'condition') && (
							<button
								title="Edit fields"
								onClick={() => setFieldsOpen((o) => !o)}
								className={`p-1 rounded hover:bg-[#3d4a57] ${fieldsOpen ? 'text-[#1a56da]' : 'text-[#637588]'}`}
							>
								<Pencil size={11} />
							</button>
						)}
						<button title="Move up" disabled={!canMoveUp} onClick={() => onOp(path, 'moveUp')} className="p-1 rounded hover:bg-[#3d4a57] text-[#637588] disabled:opacity-30 disabled:hover:bg-transparent text-[10px] leading-none w-[19px] h-[19px]">
							▲
						</button>
						<button title="Move down" disabled={!canMoveDown} onClick={() => onOp(path, 'moveDown')} className="p-1 rounded hover:bg-[#3d4a57] text-[#637588] disabled:opacity-30 disabled:hover:bg-transparent text-[10px] leading-none w-[19px] h-[19px]">
							▼
						</button>
						<button title={action.disabled ? 'Enable' : 'Disable'} onClick={() => onOp(path, 'toggleDisabled')} className="p-1 rounded hover:bg-[#3d4a57] text-[#637588]">
							<Square size={11} />
						</button>
						<button title="Duplicate" onClick={() => onOp(path, 'duplicate')} className="p-1 rounded hover:bg-[#3d4a57] text-[#637588]">
							<Copy size={11} />
						</button>
						<button title="Delete" onClick={() => onOp(path, 'delete')} className="p-1 rounded hover:bg-red-950/40 text-red-400">
							<Trash2 size={11} />
						</button>
					</span>
				)}
			</div>
			{action.type === 'condition' && fieldsOpen && (
				<div className="space-y-1 py-1" style={{ marginLeft: (depth + 1) * 16 }}>
					<ScriptConditionEditor value={action.conditions} gameData={gameData} onChange={(v) => onOp([...path, 'conditions'], 'setField', v)} />
				</div>
			)}
			{fieldsOpen && fieldSchema && (
				<div className="space-y-1 py-1" style={{ marginLeft: (depth + 1) * 16 }}>
					{fieldSchema.map((f) => (
						<div key={f.key} className="flex items-center gap-2">
							<span className="text-[10px] text-[#8291a1] w-28 shrink-0 truncate">{f.key}</span>
							<ScriptFieldInput kind={f.kind} value={action[f.key]} gameData={gameData} onChange={(v) => onOp([...path, f.key], 'setField', v)} />
						</div>
					))}
				</div>
			)}
			{hasChildren && open && (
				<div>
					{children.map((section, i) => (
						<div key={i}>
							{section.heading && <div className="text-[10px] uppercase tracking-wide text-[#637588]" style={{ marginLeft: (depth + 1) * 16 }}>{section.heading}</div>}
							<div className="flex items-center gap-1.5 py-1" style={{ marginLeft: (depth + 1) * 16 }}>
								<ScriptAddMenu label="Add action" options={collectScriptVocabulary(gameData).actions.map((type) => ({ value: type, label: readableType(type) }))} onSelect={(type) => onOp?.(section.basePath, 'insert', { index: section.actions.length, value: defaultActionForType(type) })} />
								<button type="button" onClick={() => onOp?.(section.basePath, 'insert', { index: section.actions.length, value: defaultActionForType('condition') })} className="flex items-center gap-1 px-2 py-1 rounded border border-dashed border-[#48596a] text-[10px] text-[#8291a1] hover:text-[#85B7EB]"><Plus size={11} /> Condition</button>
							</div>
							{section.actions.length === 0 ? (
								<div className="text-xs text-[#637588] italic" style={{ marginLeft: (depth + 1) * 16 }}>(nothing)</div>
							) : section.actions.map((a, i2) => (
								<ScriptActionNode key={i2} action={a} gameData={gameData} depth={depth + 1} onJumpToScript={onJumpToScript} path={[...section.basePath, i2]} onOp={onOp} siblingCount={section.actions.length} indexInParent={i2} />
							))}
						</div>
					))}
				</div>
			)}
		</div>
	);
}

function ExternalLinkIcon() {
	return <ChevronRight size={11} className="text-[#ED93B1] shrink-0 -ml-0.5" />;
}

// top-level tree for one script: its triggers, its top-level conditions gate
// (usually just `true == true`, i.e. no extra gate - only worth a line when it's
// actually something), and its action list
function ScriptTreeView({ script, gameData, onJumpToScript, onOp, onAddAction, onAddCondition, onAddTrigger }) {
	const triggers = script?.triggers || [];
	const topConditions = script?.conditions;
	const hasRealTopCondition = Array.isArray(topConditions) && topConditions.length >= 3;
	const topActions = script?.actions || [];
	const vocab = collectScriptVocabulary(gameData);
	const addActionOptions = vocab.actions.map((type) => ({ value: type, label: readableType(type) }));
	const addTriggerOptions = vocab.triggers.map((type) => ({ value: type, label: readableType(type) }));
	return (
		<div className="space-y-1">
			<div className="flex flex-wrap items-center gap-1.5 pb-2 border-b border-[#3d4a57]">
				<span className="text-[10px] uppercase tracking-wide text-[#637588] mr-1">Triggers</span>
				{triggers.map((t, i) => <div key={i} className="flex items-center gap-1.5 py-1 px-2 rounded bg-[#262e36] border border-[#3d4a57] group"><span style={{ width: 7, height: 7, borderRadius: 2, background: SCRIPT_NODE_COLORS.trigger, flexShrink: 0 }} /><span className="text-xs font-mono text-[#c5ccd3]">when: {readableType(t.type)}</span><button type="button" title="Remove trigger" onClick={() => onOp?.(['triggers', i], 'delete')} className="opacity-0 group-hover:opacity-100 p-0.5 text-red-400 hover:bg-red-950/40 rounded"><X size={11} /></button></div>)}
				{onAddTrigger && <ScriptAddMenu label="Add trigger" options={addTriggerOptions} onSelect={(type) => onAddTrigger({ type })} />}
				{triggers.length === 0 && <span className="text-[10px] text-[#637588] italic">No triggers yet</span>}
			</div>
			<div className="py-2 border-b border-[#3d4a57]">
				<div className="flex items-center justify-between gap-2 mb-1"><div className="flex items-center gap-1.5"><span style={{ width: 7, height: 7, borderRadius: 2, background: SCRIPT_NODE_COLORS.condition, flexShrink: 0 }} /><span className="text-xs font-mono text-[#c5ccd3]">Top-level condition</span></div>{hasRealTopCondition && <button type="button" onClick={() => onOp?.(['conditions'], 'setField', [])} className="text-[10px] text-red-400 hover:underline">Remove</button>}</div>
				{hasRealTopCondition ? <ScriptConditionEditor value={topConditions} gameData={gameData} onChange={(v) => onOp?.(['conditions'], 'setField', v)} /> : <div className="text-[10px] text-[#637588] flex items-center gap-2"><span>No extra gate.</span><button type="button" onClick={() => onOp?.(['conditions'], 'setField', [{ operandType: 'boolean', operator: '==' }, true, true])} className="text-[#1a56da] hover:underline">+ Add condition</button></div>}
			</div>
			<div className="flex items-center gap-1.5 pt-2 pb-1"><span className="text-[10px] uppercase tracking-wide text-[#637588] mr-1">Actions</span>{onAddAction && <ScriptAddMenu label="Add action" options={addActionOptions} onSelect={(type) => onAddAction(['actions'], topActions.length, defaultActionForType(type))} />}{onAddCondition && <button type="button" onClick={() => onAddCondition(['actions'], topActions.length)} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-dashed border-[#48596a] text-xs text-[#a3adb8] hover:border-[#85B7EB] hover:text-[#85B7EB]"><Plus size={13} /> Add condition</button>}</div>
			{topActions.map((a, i) => <ScriptActionNode key={i} action={a} gameData={gameData} depth={0} onJumpToScript={onJumpToScript} path={['actions', i]} onOp={onOp} siblingCount={topActions.length} indexInParent={i} />)}
			{topActions.length === 0 && <div className="text-xs text-[#637588] italic px-1.5 py-2">No actions yet. Add an action or condition above.</div>}
		</div>
	);
}

export default function GameContentEditor() {
	const [gameData, setGameData] = useState(null);
	const [editingPlayerTypeKey, setEditingPlayerTypeKey] = useState(null);
	const [fileName, setFileName] = useState('');
	const [fileError, setFileError] = useState('');
	const [activeTab, setActiveTab] = useState('unitTypes');
	const [selectedKey, setSelectedKey] = useState(null);
	const [selectedFolderId, setSelectedFolderId] = useState(null);
	const [collapsed, setCollapsed] = useState({}); // folderId -> bool, UI-only
	const [selectedScriptFolderId, setSelectedScriptFolderId] = useState(null);
	const [scriptCollapsed, setScriptCollapsed] = useState({});
	const [scriptDraft, setScriptDraft] = useState(null);
	const [scriptViewMode, setScriptViewMode] = useState('tree'); // 'tree' | 'raw'
	const [scriptBodyError, setScriptBodyError] = useState('');
	const [dialogueDraft, setDialogueDraft] = useState(null);
	const [draft, setDraft] = useState(null);
	const [groupDraft, setGroupDraft] = useState(null);
	const [advancedText, setAdvancedText] = useState('');
	const [advancedError, setAdvancedError] = useState('');
	const [search, setSearch] = useState('');
	const [showNewModal, setShowNewModal] = useState(false);
	const [cloneFrom, setCloneFrom] = useState('');
	const [savedMsg, setSavedMsg] = useState('');
	const [gridPreview, setGridPreview] = useState({ cols: 1, rows: 1 });
	const [selectedBodyName, setSelectedBodyName] = useState('default');
	const [selectedEntityScriptKey, setSelectedEntityScriptKey] = useState('');
	const [entityScriptViewMode, setEntityScriptViewMode] = useState('tree'); // 'tree' | 'raw'
	const [spriteNatural, setSpriteNatural] = useState(null); // {w, h} of the currently loaded sprite sheet image
	const [assetBaseUrl, setAssetBaseUrl] = useState(() => localStorage.getItem('editorAssetBaseUrl') || '');
	const [previewingSoundKey, setPreviewingSoundKey] = useState(null);
	const fileInputRef = useRef(null);
	const soundPreviewAudioRef = useRef(null);

	function updateAssetBaseUrl(value) {
		setAssetBaseUrl(value);
		localStorage.setItem('editorAssetBaseUrl', value);
	}

	// sprite/sound urls
	function resolveAssetUrl(url) {
		if (!url) return '';
		if (/^https?:\/\//i.test(url)) return url;
		if (!assetBaseUrl) return url;

		const base = assetBaseUrl.replace(/\/$/, '');
		let path = url.startsWith('/') ? url : '/' + url;

		// avoid a doubled path segment when the configured base URL already ends
		// in the same folder name the file path starts with - e.g. base
		// ".../taro2/master/assets" + file "/assets/audio/x.wav" naively
		// concatenates to ".../assets/assets/audio/x.wav", a 404. Confirmed via
		// direct request: the doubled path 404s, the de-duplicated one 200s with
		// the correct audio/wav content-type. This happened because the sound
		// migration generated paths relative to the repo root (assets/audio/...)
		// while the base URL here is configured one folder deeper (.../assets),
		// a convention mismatch sprites apparently didn't hit.
		const lastBaseSegment = base.split('/').pop();
		const pathSegments = path.split('/').filter(Boolean);
		if (lastBaseSegment && pathSegments[0] === lastBaseSegment) {
			path = '/' + pathSegments.slice(1).join('/');
		}

		return base + path;
	}

	const isEntityTab = ENTITY_TABS.some((t) => t.key === activeTab);
	const activeTabDef = ENTITY_TABS.find((t) => t.key === activeTab);
	const categoryMap = gameData?.data?.[activeTab] || {};
	const itemTypes = gameData?.data?.itemTypes || {};
	const attributeTypes = gameData?.data?.attributeTypes || {};
	const playerAttributeTypes = attributeTypes;
	const soundTypes = gameData?.data?.sound || {};
	const playerTypes = gameData?.data?.playerTypes || {};
	const folders = gameData?.data?.folders || {};

	const isGroupTab = GROUP_TABS.some((t) => t.key === activeTab);
	const activeGroupDef = GROUP_TABS.find((t) => t.key === activeTab);
	const groupMemberCollection = gameData?.data?.[activeGroupDef?.collection] || {};

	const filteredEntries = useMemo(() => {
		const entries = Object.entries(categoryMap);
		entries.sort((a, b) => (a[1]?.name || '').localeCompare(b[1]?.name || ''));
		if (!search.trim()) return entries;
		const q = search.toLowerCase();
		return entries.filter(([k, v]) => (v?.name || '').toLowerCase().includes(q) || k.toLowerCase().includes(q));
	}, [categoryMap, search]);

	// folder tree
	const tree = useMemo(() => {
		if (!isEntityTab || !gameData) return [];
		function build(parentId) {
			const kids = Object.entries(folders).filter(([, v]) => v.parent === parentId);
			const subFolders = kids
				.filter(([, v]) => v.type === 'folder')
				.sort((a, b) => (a[1].name || '').localeCompare(b[1].name || ''))
				.map(([id, v]) => ({ kind: 'folder', id, name: v.name, children: build(id) }));
			const entities = kids
				.filter(([, v]) => v.type === activeTabDef.folderType)
				.filter(([id]) => categoryMap[id])
				.map(([id]) => ({ kind: 'entity', id }))
				.sort((a, b) => (categoryMap[a.id]?.name || '').localeCompare(categoryMap[b.id]?.name || ''));
			return [...subFolders, ...entities];
		}
		return build(activeTabDef.root);
	}, [gameData, activeTab, folders, categoryMap, isEntityTab, activeTabDef]);

	const folderOptions = useMemo(() => {
		if (!isEntityTab || !gameData) return [];
		return flattenFolderOptions(folders, activeTabDef.root);
	}, [gameData, folders, activeTabDef, isEntityTab]);

	const groupVariableEntries = useMemo(() => {
		if (!isGroupTab || !gameData) return [];
		const entries = Object.entries(gameData.data.variables || {}).filter(
			([, v]) => v?.dataType === activeGroupDef.dataType
		);
		entries.sort((a, b) => a[0].localeCompare(b[0]));
		if (!search.trim()) return entries;
		const q = search.toLowerCase();
		return entries.filter(([k]) => k.toLowerCase().includes(q));
	}, [gameData, isGroupTab, activeGroupDef, search]);

	const isScriptsTab = activeTab === 'globalScripts';
	const scriptsCollection = gameData?.data?.scripts || {};

	// search and rendering of folders
	const scriptSearchResults = useMemo(() => {
		if (!isScriptsTab || !search.trim()) return [];
		const q = search.toLowerCase();
		return Object.entries(scriptsCollection)
			.filter(([, v]) => 'triggers' in v && ((v.name || '').toLowerCase().includes(q)))
			.sort((a, b) => (a[1].name || '').localeCompare(b[1].name || ''));
	}, [isScriptsTab, search, scriptsCollection]);

	const scriptTree = useMemo(() => {
		if (!isScriptsTab || !gameData || search.trim()) return [];
		function build(parentId) {
			const kids = Object.entries(scriptsCollection).filter(([, v]) => (v.parent ?? null) === parentId);
			const folders = kids
				.filter(([, v]) => 'folderName' in v)
				.sort((a, b) => (a[1].order ?? 0) - (b[1].order ?? 0))
				.map(([id, v]) => ({ kind: 'folder', id, name: v.folderName, children: build(id) }));
			const leaves = kids
				.filter(([, v]) => 'triggers' in v)
				.sort((a, b) => (a[1].name || '').localeCompare(b[1].name || ''))
				.map(([id]) => ({ kind: 'script', id }));
			return [...folders, ...leaves];
		}
		return build(null);
	}, [isScriptsTab, gameData, scriptsCollection, search]);

	const scriptFolderOptions = useMemo(() => {
		if (!isScriptsTab || !gameData) return [];
		const out = [{ id: null, depth: 0, name: '(top level)' }];
		function walk(parentId, depth) {
			Object.entries(scriptsCollection)
				.filter(([, v]) => 'folderName' in v && (v.parent ?? null) === parentId)
				.sort((a, b) => (a[1].order ?? 0) - (b[1].order ?? 0))
				.forEach(([id, v]) => {
					out.push({ id, depth, name: v.folderName });
					walk(id, depth + 1);
				});
		}
		walk(null, 1);
		return out;
	}, [isScriptsTab, gameData, scriptsCollection]);

	// live-parsed body for the tree view - separate from the save-time validation
	// (scriptBodyError) so switching to tree view always reflects whatever's
	// currently typed in the raw JSON box, valid or not.
	const scriptDraftParsed = useMemo(() => {
		if (!scriptDraft) return { value: null, error: null };
		if (!scriptDraft.bodyText.trim()) return { value: { triggers: [], conditions: [], actions: [] }, error: null };
		try {
			return { value: JSON.parse(scriptDraft.bodyText), error: null };
		} catch (e) {
			return { value: null, error: e.message };
		}
	}, [scriptDraft]);

	const isDialoguesTab = activeTab === 'dialogues';
	const dialoguesCollection = gameData?.data?.dialogues || {};

	// dialogue
	const pickableScripts = useMemo(
		() =>
			Object.entries(scriptsCollection)
				.filter(([, v]) => 'triggers' in v)
				.sort((a, b) => (a[1].name || '').localeCompare(b[1].name || '')),
		[scriptsCollection]
	);

	const dialogueEntries = useMemo(() => {
		if (!isDialoguesTab || !gameData) return [];
		const entries = Object.entries(dialoguesCollection);
		entries.sort((a, b) => (a[1]?.name || '').localeCompare(b[1]?.name || ''));
		if (!search.trim()) return entries;
		const q = search.toLowerCase();
		return entries.filter(([k, v]) => (v?.name || '').toLowerCase().includes(q) || k.toLowerCase().includes(q));
	}, [isDialoguesTab, gameData, dialoguesCollection, search]);

	function handleUpload(e) {
		const file = e.target.files[0];
		if (!file) return;
		setFileError('');
		setFileName(file.name);
		const reader = new FileReader();
		reader.onload = (evt) => {
			try {
				const parsed = JSON.parse(evt.target.result);
				if (!parsed?.data) throw new Error("This doesn't look like a game.json - no top-level \"data\" field found.");
				normalizeFolders(parsed);
				setGameData(parsed);
				setSelectedKey(null);
				setSelectedFolderId(null);
				setDraft(null);
			} catch (err) {
				setFileError(err.message);
			}
		};
		reader.readAsText(file);
	}

	function loadDraftFromEntity(key, entity) {
		const { name, attributes, variables, cellSheet, bodies, effects, defaultItems, inventorySize, scripts, type, delayBeforeUse, quantity, maxQuantity, inventoryImage, description, fireRate, reloadRate, showCDOverlay, knockbackForce, isStackable, isPurchasable, carriedBy, canBeUsedBy, controls, projectileType, cost, damage, lifeSpan, ...rest } = entity;
		const clonedBodies = deepClone(bodies) || { default: { type: 'dynamic', width: TILE_PX, height: TILE_PX } };
		setDraft({
			key,
			name: name || '',
			attributes: deepClone(attributes) || {},
			variables: deepClone(variables) || {},
			cellSheet: { ...(deepClone(cellSheet) || { url: '', columnCount: 1, rowCount: 1 }), columnCount: Math.max(1, Number(cellSheet?.columnCount) || 1), rowCount: Math.max(1, Number(cellSheet?.rowCount) || 1) },
			bodies: clonedBodies,
			effects: activeTab === 'itemTypes' ? (deepClone(effects) || { use: { sound: {} }, create: { sound: {} }, destroy: { sound: {} } }) : deepClone(effects),
			...(activeTab === 'unitTypes'
				? {
					defaultItems: deepClone(defaultItems) || [],
					inventorySize: Number.isFinite(Number(inventorySize)) ? Math.min(9, Math.max(0, Number(inventorySize))) : 1,
				}
				: {}),
			scripts: deepClone(scripts) || {},
			controls: activeTab === 'unitTypes' ? (Object.keys(controls || {}).length ? deepClone(controls) : deepClone(DEFAULT_UNIT_CONTROLS)) : (deepClone(controls) || {}),
			...(activeTab === 'itemTypes' ? { type: type || '', delayBeforeUse: Number.isFinite(Number(delayBeforeUse)) ? Number(delayBeforeUse) : 0, quantity: quantity ?? null, maxQuantity: maxQuantity ?? null, inventoryImage: inventoryImage || '', description: description || '', fireRate: Number.isFinite(Number(fireRate)) ? Number(fireRate) : 0, reloadRate: Number.isFinite(Number(reloadRate)) ? Number(reloadRate) : 0, showCDOverlay: !!showCDOverlay, knockbackForce: Number.isFinite(Number(knockbackForce)) ? Number(knockbackForce) : 0, isStackable: !!isStackable, isPurchasable: !!isPurchasable, carriedBy: deepClone(carriedBy) || [], canBeUsedBy: deepClone(canBeUsedBy) || [], projectileType: projectileType || '', cost: deepClone(cost) || {}, damage: deepClone(damage) || {} } : {}),
			...(activeTab === 'projectileTypes' ? { lifeSpan: lifeSpan ?? null } : {}),
			costUnitAttributes: deepClone(entity.cost?.unitAttributes) || {},
			costPlayerAttributes: deepClone(entity.cost?.playerAttributes) || {},
			damageUnitAttributes: deepClone(entity.damage?.unitAttributes) || {},
			damagePlayerAttributes: deepClone(entity.damage?.playerAttributes) || {},
			folderId: folders[key]?.parent ?? activeTabDef.root,
			isNew: false,
		});
		setSelectedBodyName(clonedBodies.default ? 'default' : Object.keys(clonedBodies)[0]);
		setSelectedEntityScriptKey('');
		setSpriteNatural(null);
		setGridPreview({ cols: cellSheet?.columnCount || 1, rows: cellSheet?.rowCount || 1 });
		setAdvancedText(JSON.stringify(rest, null, 2));
		setAdvancedError('');
		setSavedMsg('');
	}

	function selectEntity(key) {
		setSelectedKey(key);
		loadDraftFromEntity(key, categoryMap[key] || {});
	}

	function startNew(baseKey) {
		const defaultUnitControls = {
			movementMethod: 'velocity',
			movementControlScheme: 'wasd',
			movementType: 'wasd',
			mouseBehaviour: { rotateToFaceMouseCursor: true, flipSpriteHorizontallyWRTMouse: false },
			absoluteRotation: false,
			clientPredictedMovement: true,
			permittedInventorySlots: [],
			unitAbilities: {},
			abilities: {},
		};
		const base = baseKey ? deepClone(categoryMap[baseKey]) : {};
		const newKey = generateKey();
		const { name, attributes, variables, cellSheet, bodies, effects, defaultItems, inventorySize, scripts, type, delayBeforeUse, quantity, maxQuantity, inventoryImage, description, fireRate, reloadRate, showCDOverlay, knockbackForce, isStackable, isPurchasable, carriedBy, canBeUsedBy, controls, projectileType, cost, damage, lifeSpan, ...rest } = base;
		const clonedBodies = deepClone(bodies) || { default: { type: 'dynamic', width: TILE_PX, height: TILE_PX } };
		setSelectedKey(newKey);
		setDraft({
			key: newKey,
			name: baseKey ? `${name || 'Unnamed'} Copy` : 'New ' + ENTITY_TABS.find((t) => t.key === activeTab)?.label.slice(0, -1),
			attributes: deepClone(attributes) || {},
			variables: deepClone(variables) || {},
			cellSheet: { ...(deepClone(cellSheet) || { url: '', columnCount: 1, rowCount: 1 }), columnCount: Math.max(1, Number(cellSheet?.columnCount) || 1), rowCount: Math.max(1, Number(cellSheet?.rowCount) || 1) },
			bodies: clonedBodies,
			effects: activeTab === 'itemTypes' ? (deepClone(effects) || { use: { sound: {} }, create: { sound: {} }, destroy: { sound: {} } }) : deepClone(effects),
			scripts: deepClone(scripts) || {},
			controls: activeTab === 'unitTypes' ? (Object.keys(controls || {}).length ? deepClone(controls) : deepClone(DEFAULT_UNIT_CONTROLS)) : (deepClone(controls) || {}),
			...(activeTab === 'unitTypes'
				? { defaultItems: deepClone(defaultItems) || [], inventorySize: Number.isFinite(Number(inventorySize)) ? Math.min(9, Math.max(0, Number(inventorySize))) : 1 }
				: {}),
			...(activeTab === 'itemTypes' ? { type: type || '', delayBeforeUse: Number.isFinite(Number(delayBeforeUse)) ? Number(delayBeforeUse) : 0, quantity: quantity ?? null, maxQuantity: maxQuantity ?? null, inventoryImage: inventoryImage || '', description: description || '', fireRate: Number.isFinite(Number(fireRate)) ? Number(fireRate) : 0, reloadRate: Number.isFinite(Number(reloadRate)) ? Number(reloadRate) : 0, showCDOverlay: !!showCDOverlay, knockbackForce: Number.isFinite(Number(knockbackForce)) ? Number(knockbackForce) : 0, isStackable: !!isStackable, isPurchasable: !!isPurchasable, carriedBy: deepClone(carriedBy) || [], canBeUsedBy: deepClone(canBeUsedBy) || [], projectileType: projectileType || '', cost: deepClone(cost) || {}, damage: deepClone(damage) || {} } : {}),
			...(activeTab === 'projectileTypes' ? { lifeSpan: lifeSpan ?? null } : {}),
			costUnitAttributes: deepClone(base.cost?.unitAttributes) || {},
			costPlayerAttributes: deepClone(base.cost?.playerAttributes) || {},
			damageUnitAttributes: deepClone(base.damage?.unitAttributes) || {},
			damagePlayerAttributes: deepClone(base.damage?.playerAttributes) || {},
			folderId: selectedFolderId || activeTabDef.root,
			isNew: true,
		});
		setSelectedBodyName(clonedBodies.default ? 'default' : Object.keys(clonedBodies)[0]);
		setSelectedEntityScriptKey('');
		setSpriteNatural(null);
		setGridPreview({ cols: cellSheet?.columnCount || 1, rows: cellSheet?.rowCount || 1 });
		setAdvancedText(JSON.stringify(rest, null, 2));
		setAdvancedError('');
		setShowNewModal(false);
		setCloneFrom('');
		setSavedMsg('');
	}

	function addAttribute(attrKey) {
		if (!attrKey || draft.attributes[attrKey]) return;
		const def = attributeTypes[attrKey];
		setDraft((d) => ({
			...d,
			attributes: {
				...d.attributes,
				[attrKey]: { value: def?.value ?? 0, min: def?.min ?? 0, max: def?.max ?? 100 },
			},
		}));
	}

	function removeAttribute(attrKey) {
		setDraft((d) => {
			const next = { ...d.attributes };
			delete next[attrKey];
			return { ...d, attributes: next };
		});
	}

	function updateAttributeField(attrKey, field, value) {
		setDraft((d) => ({
			...d,
			attributes: { ...d.attributes, [attrKey]: { ...d.attributes[attrKey], [field]: value } },
		}));
	}

	function addDefaultItem(itemKey) {
		if (activeTab !== 'unitTypes' || !itemKey) return;
		const item = itemTypes[itemKey];
		if (!item) return;
		setDraft((d) => ({
			...d,
			defaultItems: [
				...(d.defaultItems || []),
				{ key: itemKey, value: item.name || itemKey, name: item.name || itemKey },
			],
		}));
	}

	function removeDefaultItem(index) {
		setDraft((d) => ({
			...d,
			defaultItems: (d.defaultItems || []).filter((_, i) => i !== index),
		}));
	}

	function addVariable() {
		const name = prompt('New variable name (e.g. targetLocked):');
		if (!name || draft.variables[name]) return;
		setDraft((d) => ({ ...d, variables: { ...d.variables, [name]: { default: '', dataType: 'string' } } }));
	}

	function removeVariable(name) {
		setDraft((d) => {
			const next = { ...d.variables };
			delete next[name];
			return { ...d, variables: next };
		});
	}

	function updateVariableField(name, field, value) {
		setDraft((d) => ({ ...d, variables: { ...d.variables, [name]: { ...d.variables[name], [field]: value } } }));
	}

	function updateCellSheetField(field, value) {
		setDraft((d) => ({ ...d, cellSheet: { ...d.cellSheet, [field]: value } }));
		if (field === 'columnCount') setGridPreview((g) => ({ ...g, cols: Number(value) || 1 }));
		if (field === 'rowCount') setGridPreview((g) => ({ ...g, rows: Number(value) || 1 }));
	}

	function updateBodySize(field, value) {
		setDraft((d) => ({
			...d,
			bodies: {
				...d.bodies,
				[selectedBodyName]: { ...d.bodies[selectedBodyName], [field]: Number(value) || 0 },
			},
		}));
	}

	function addBody() {
		const name = prompt('New body name (e.g. crouching):');
		if (!name || draft.bodies[name]) return;
		setDraft((d) => ({
			...d,
			bodies: { ...d.bodies, [name]: { type: 'dynamic', width: TILE_PX, height: TILE_PX } },
		}));
		setSelectedBodyName(name);
	}

	function removeBody(name) {
		const remaining = Object.keys(draft.bodies).filter((k) => k !== name);
		if (remaining.length === 0) {
			alert("Can't remove the last body - every unit/item/projectile needs at least one.");
			return;
		}
		setDraft((d) => {
			const next = { ...d.bodies };
			delete next[name];
			return { ...d, bodies: next };
		});
		if (selectedBodyName === name) setSelectedBodyName(remaining[0]);
	}

	function updateDraftField(field, value) {
		setDraft((d) => ({ ...d, [field]: value }));
	}

	function updateDraftNestedField(section, field, value) {
		setDraft((d) => ({ ...d, [section]: { ...(d[section] || {}), [field]: value } }));
	}

	function updateMappedValue(section, key, value) {
		setDraft((d) => ({
			...d,
			[section]: { ...(d[section] || {}), [key]: value },
		}));
	}

	function removeMappedValue(section, key) {
		setDraft((d) => {
			const next = { ...(d[section] || {}) };
			delete next[key];
			return { ...d, [section]: next };
		});
	}

	function addMappedValue(section, key, value = 0) {
		if (!key) return;
		setDraft((d) => ({
			...d,
			[section]: { ...(d[section] || {}), [key]: value },
		}));
	}

	function normalizeTargetList(value) {
		return Array.from(new Set(Array.isArray(value) ? value.filter(Boolean) : []));
	}

	function toggleDamageTarget(target) {
		setDraft((d) => {
			const current = normalizeTargetList(d.damage?.targetsAffected);
			const next = current.includes(target) ? current.filter((x) => x !== target) : [...current, target];
			return { ...d, damage: { ...(d.damage || {}), targetsAffected: next } };
		});
	}

	function getEntityScriptEntries() {
		const map = draft?.scripts || {};
		return Object.entries(map)
			.filter(([, value]) => value && 'triggers' in value)
			.sort((a, b) => (a[1].name || '').localeCompare(b[1].name || ''));
	}

	function selectEntityScript(key) {
		setSelectedEntityScriptKey(key);
	}

	function updateEntityScriptBody(key, bodyText) {
		setDraft((d) => ({
			...d,
			scripts: {
				...(d.scripts || {}),
				[key]: { ...(d.scripts?.[key] || {}), _editorBodyText: bodyText },
			},
		}));
	}

	function saveEntityScriptBody(key) {
		const script = draft?.scripts?.[key];
		if (!script) return;
		const text = script._editorBodyText;
		if (typeof text !== 'string') return;
		try {
			const body = text.trim() ? JSON.parse(text) : { triggers: [], conditions: [], actions: [] };
			setDraft((d) => ({
				...d,
				scripts: {
					...(d.scripts || {}),
					[key]: { ...body, key, name: script.name || '', parent: script.parent ?? null, order: script.order ?? 0 },
				},
			}));
		} catch (err) {
			alert('Script JSON is invalid: ' + err.message);
		}
	}

	function updateEntityEffectSound(eventName, soundKey, enabled) {
		if (!['itemTypes', 'unitTypes', 'projectileTypes'].includes(activeTab) || !soundKey) return;
		setDraft((d) => {
			const effects = { ...(d.effects || {}) };
			const effect = { ...(effects[eventName] || {}), sound: { ...((effects[eventName] || {}).sound || {}) } };
			if (enabled) {
				const sound = soundTypes[soundKey];
				if (sound) effect.sound[soundKey] = deepClone(sound);
			} else {
				delete effect.sound[soundKey];
			}
			effects[eventName] = effect;
			return { ...d, effects };
		});
	}

	function removeEntityEffectSound(eventName, soundKey) {
		updateEntityEffectSound(eventName, soundKey, false);
	}

	function updateItemEffectSound(eventName, soundKey, enabled) {
		updateEntityEffectSound(eventName, soundKey, enabled);
	}

	function removeItemEffectSound(eventName, soundKey) {
		removeEntityEffectSound(eventName, soundKey);
	}

	function addGlobalSound() {
		const key = generateKey();
		setGameData((gd) => {
			const next = deepClone(gd);
			if (!next.data.sound) next.data.sound = {};
			next.data.sound[key] = { name: 'New Sound', file: '', volume: 100, pitchRandomization: 0.1 };
			return next;
		});
		setSelectedKey(key);
		// New sounds are inserted alphabetically by name (every one starts out
		// named "New Sound"), so on a list with existing entries it can land
		// anywhere in the middle - with no visual cue, that reads as "the button
		// didn't do anything." Scroll the new card into view and focus its name
		// field so it's unmistakable something was actually added.
		requestAnimationFrame(() => {
			const $card = document.querySelector('[data-sound-key="' + key + '"]');
			if ($card) {
				$card.scrollIntoView({ behavior: 'smooth', block: 'center' });
				const $nameInput = $card.querySelector('input');
				if ($nameInput) $nameInput.focus();
			}
		});
	}

	function updateGlobalSound(key, field, value) {
		setGameData((gd) => {
			const next = deepClone(gd);
			if (!next.data.sound) next.data.sound = {};
			next.data.sound[key] = { ...(next.data.sound[key] || {}), [field]: value };
			return next;
		});
	}

	function deleteGlobalSound(key) {
		if (!key || !window.confirm('Remove this sound from the global sound library? Existing item effect entries already containing a copy will not be changed.')) return;
		setGameData((gd) => {
			const next = deepClone(gd);
			delete next.data.sound[key];
			return next;
		});
		if (selectedKey === key) setSelectedKey(null);
	}

	function previewGlobalSound(key) {
		const sound = soundTypes[key];
		if (!sound?.file) {
			alert('This sound does not have a file URL yet.');
			return;
		}

		if (soundPreviewAudioRef.current) {
			soundPreviewAudioRef.current.pause();
			soundPreviewAudioRef.current.currentTime = 0;
			soundPreviewAudioRef.current = null;
		}

		if (previewingSoundKey === key) {
			setPreviewingSoundKey(null);
			return;
		}

		const resolvedUrl = resolveAssetUrl(sound.file);
		const audio = new Audio(resolvedUrl);
		const variation = Math.max(0, Math.min(1, Number(sound.pitchRandomization ?? 0.1) || 0));
		audio.volume = Math.max(0, Math.min(1, Number(sound.volume ?? 100) / 100));
		audio.playbackRate = 1 + (Math.random() * 2 - 1) * variation;
		audio.addEventListener('ended', () => {
			if (soundPreviewAudioRef.current === audio) {
				soundPreviewAudioRef.current = null;
				setPreviewingSoundKey(null);
			}
		});
		audio.addEventListener('error', () => {
			// audio.error.code: 1=ABORTED 2=NETWORK 3=DECODE 4=SRC_NOT_SUPPORTED
			// (i.e. wrong URL / 404 / CORS vs. bad file format - very different
			// fixes, so surfacing which one it is matters)
			const codeNames = { 1: 'ABORTED', 2: 'NETWORK', 3: 'DECODE', 4: 'SRC_NOT_SUPPORTED' };
			const code = audio.error?.code;
			console.error(
				`Sound preview failed for "${sound.name || key}".\n` +
				`  raw file value: ${sound.file}\n` +
				`  resolved URL: ${resolvedUrl}\n` +
				`  error code: ${code} (${codeNames[code] || 'unknown'})`
			);
			alert(
				`Couldn't play "${sound.name || key}" (${codeNames[code] || 'unknown error'}).\n\n` +
				`Tried to load:\n${resolvedUrl}\n\n` +
				`Open the browser console for the full detail - if this is a 404/NETWORK error, ` +
				`the file likely didn't make it to its new host at that exact path; if it's ` +
				`SRC_NOT_SUPPORTED, the new host may be serving the file with a MIME type the ` +
				`browser doesn't recognize as audio.`
			);
			if (soundPreviewAudioRef.current === audio) {
				soundPreviewAudioRef.current = null;
				setPreviewingSoundKey(null);
			}
		});
		soundPreviewAudioRef.current = audio;
		setPreviewingSoundKey(key);
		audio.play().catch((err) => {
			console.error(`Sound preview .play() rejected for "${sound.name || key}" (resolved URL: ${resolvedUrl}):`, err);
			if (soundPreviewAudioRef.current === audio) {
				soundPreviewAudioRef.current = null;
				setPreviewingSoundKey(null);
			}
		});
	}

	function saveDraft() {
		let restParsed;
		try {
			restParsed = advancedText.trim() ? JSON.parse(advancedText) : {};
		} catch (err) {
			setAdvancedError('Advanced JSON is invalid: ' + err.message);
			return;
		}
		setAdvancedError('');
		const finalCost = {
			...(draft.cost || {}),
			...(draft.costUnitAttributes ? { unitAttributes: draft.costUnitAttributes } : {}),
			...(draft.costPlayerAttributes ? { playerAttributes: draft.costPlayerAttributes } : {}),
		};
		const finalDamage = {
			...(draft.damage || {}),
			...(draft.damageUnitAttributes ? { unitAttributes: draft.damageUnitAttributes } : {}),
			...(draft.damagePlayerAttributes ? { playerAttributes: draft.damagePlayerAttributes } : {}),
		};
		const finalCellSheet = {
			...(draft.cellSheet || {}),
			columnCount: Math.max(1, Number(draft.cellSheet?.columnCount) || 1),
			rowCount: Math.max(1, Number(draft.cellSheet?.rowCount) || 1),
		};
		for (const [key, value] of Object.entries(draft.scripts || {})) {
			if (typeof value?._editorBodyText === 'string') {
				try { JSON.parse(value._editorBodyText.trim() || '{\"triggers\":[],\"conditions\":[],\"actions\":[]}'); }
				catch (err) { setAdvancedError(`Embedded script "${value?.name || key}" is invalid: ${err.message}`); return; }
			}
		}

		const finalEntity = {
			...restParsed,
			id: draft.key,
			name: draft.name,
			attributes: draft.attributes,
			variables: draft.variables,
			cellSheet: finalCellSheet,
			bodies: draft.bodies,
			controls: deepClone(draft.controls) || {},
			...(draft.effects !== undefined ? { effects: deepClone(draft.effects) } : {}),
			scripts: Object.fromEntries(Object.entries(draft.scripts || {}).map(([key, value]) => {
				const { _editorBodyText, ...cleanScript } = value || {};
				if (typeof _editorBodyText === 'string') {
					try {
						const parsedBody = _editorBodyText.trim() ? JSON.parse(_editorBodyText) : { triggers: [], conditions: [], actions: [] };
						return [key, { ...parsedBody, key: cleanScript.key ?? key, name: cleanScript.name || '', parent: cleanScript.parent ?? null, order: cleanScript.order ?? 0 }];
					} catch (err) {
						throw new Error(`Embedded script "${cleanScript.name || key}" is invalid: ${err.message}`);
					}
				}
				return [key, cleanScript];
			})),
			...(activeTab === 'itemTypes' ? { cost: finalCost, damage: finalDamage } : {}),
			...(activeTab === 'itemTypes' ? { type: draft.type || '', delayBeforeUse: Number(draft.delayBeforeUse) || 0, quantity: draft.quantity ?? null, maxQuantity: draft.maxQuantity ?? null, inventoryImage: draft.inventoryImage || '', description: draft.description || '', fireRate: Number(draft.fireRate) || 0, reloadRate: Number(draft.reloadRate) || 0, showCDOverlay: !!draft.showCDOverlay, knockbackForce: Number(draft.knockbackForce) || 0, isStackable: !!draft.isStackable, isPurchasable: !!draft.isPurchasable, carriedBy: deepClone(draft.carriedBy) || [], canBeUsedBy: deepClone(draft.canBeUsedBy) || [], projectileType: draft.projectileType || '' } : {}),
			...(activeTab === 'projectileTypes' ? { lifeSpan: draft.lifeSpan ?? null } : {}),
		};
		if (activeTab === 'unitTypes') {
			finalEntity.inventorySize = Math.min(9, Math.max(0, Number(draft.inventorySize) || 0));
			finalEntity.defaultItems = deepClone(draft.defaultItems) || [];
		}
		setGameData((gd) => {
			const next = deepClone(gd);
			next.data[activeTab][draft.key] = finalEntity;
			if (!next.data.folders) next.data.folders = {};
			next.data.folders[draft.key] = {
				...(next.data.folders[draft.key] || {}),
				type: activeTabDef.folderType,
				parent: draft.folderId || activeTabDef.root,
				closed: false,
			};
			return next;
		});
		setDraft((d) => ({ ...d, isNew: false }));
		setSavedMsg('Saved to the working copy in this tool. Download the file below to keep it.');
	}

	function deleteEntity() {
		if (!selectedKey) return;
		if (!window.confirm('Remove this entry from the working copy? This can\'t be undone in the tool.')) return;
		setGameData((gd) => {
			const next = deepClone(gd);
			delete next.data[activeTab][selectedKey];
			if (next.data.folders) delete next.data.folders[selectedKey];
			return next;
		});
		setSelectedKey(null);
		setDraft(null);
	}

	function selectGroup(key) {
		const v = gameData.data.variables[key];
		setSelectedKey(key);
		setGroupDraft({ key, originalKey: key, entries: deepClone(v?.default) || {}, isNew: false });
		setSavedMsg('');
	}

	function startNewGroup() {
		const name = prompt('New group name (e.g. "Day Zombies"):');
		if (!name) return;
		if (gameData.data.variables?.[name]) {
			alert('A variable named "' + name + '" already exists. Pick a different name.');
			return;
		}
		setSelectedKey(name);
		setGroupDraft({ key: name, originalKey: null, entries: {}, isNew: true });
		setSavedMsg('');
	}

	function addGroupMember(id) {
		if (!id || groupDraft.entries[id]) return;
		setGroupDraft((d) => ({ ...d, entries: { ...d.entries, [id]: { probability: 20, quantity: 1 } } }));
	}

	function removeGroupMember(id) {
		setGroupDraft((d) => {
			const next = { ...d.entries };
			delete next[id];
			return { ...d, entries: next };
		});
	}

	function updateGroupMemberField(id, field, value) {
		setGroupDraft((d) => ({
			...d,
			entries: { ...d.entries, [id]: { ...d.entries[id], [field]: value } },
		}));
	}

	function saveGroupDraft() {
		const trimmed = groupDraft.key.trim();
		if (!trimmed) {
			alert('This group needs a name.');
			return;
		}
		if (trimmed !== groupDraft.originalKey && gameData.data.variables?.[trimmed]) {
			alert('A variable named "' + trimmed + '" already exists. Pick a different name.');
			return;
		}
		setGameData((gd) => {
			const next = deepClone(gd);
			if (!next.data.variables) next.data.variables = {};
			if (!groupDraft.isNew && groupDraft.originalKey && groupDraft.originalKey !== trimmed) {
				delete next.data.variables[groupDraft.originalKey];
			}
			next.data.variables[trimmed] = { default: groupDraft.entries, dataType: activeGroupDef.dataType };
			return next;
		});
		setSelectedKey(trimmed);
		setGroupDraft((d) => ({ ...d, key: trimmed, originalKey: trimmed, isNew: false }));
		setSavedMsg('Saved to the working copy in this tool. Download the file below to keep it.');
	}

	function deleteGroup() {
		if (!selectedKey) return;
		if (!window.confirm('Remove this group from the working copy? Anything referencing it by name in your scripts would break.')) return;
		setGameData((gd) => {
			const next = deepClone(gd);
			delete next.data.variables[selectedKey];
			return next;
		});
		setSelectedKey(null);
		setGroupDraft(null);
	}

	function selectScript(key) {
		const s = scriptsCollection[key];
		if (!s) return;
		const { name, parent, order, key: _k, ...body } = s;
		setSelectedKey(key);
		setScriptDraft({ key, name: name || '', parentId: parent ?? null, isNew: false, bodyText: JSON.stringify(body, null, 2) });
		setScriptBodyError('');
		setSavedMsg('');
	}

	function startNewScript(parentId) {
		const name = prompt('New script name:');
		if (!name) return;
		const id = generateKey();
		setSelectedKey(id);
		setScriptDraft({
			key: id,
			name,
			parentId: parentId ?? null,
			isNew: true,
			bodyText: JSON.stringify({ triggers: [], conditions: [], actions: [] }, null, 2),
		});
		setScriptBodyError('');
		setSavedMsg('');
	}

	function saveScriptDraft() {
		let body;
		try {
			body = scriptDraft.bodyText.trim() ? JSON.parse(scriptDraft.bodyText) : { triggers: [], conditions: [], actions: [] };
		} catch (err) {
			setScriptBodyError('Script JSON is invalid: ' + err.message);
			return;
		}
		setScriptBodyError('');
		setGameData((gd) => {
			const next = deepClone(gd);
			if (!next.data.scripts) next.data.scripts = {};
			next.data.scripts[scriptDraft.key] = {
				...body,
				key: scriptDraft.key,
				name: scriptDraft.name,
				parent: scriptDraft.parentId,
				order: next.data.scripts[scriptDraft.key]?.order ?? 0,
			};
			return next;
		});
		setScriptDraft((d) => ({ ...d, isNew: false }));
		setSavedMsg('Saved to the working copy in this tool. Download the file below to keep it.');
	}

	function updateScriptTree(nextBody) {
		setScriptDraft((d) => ({ ...d, bodyText: JSON.stringify(nextBody, null, 2) }));
	}

	function addScriptTrigger(trigger) {
		if (!scriptDraftParsed.value) return;
		const next = deepClone(scriptDraftParsed.value);
		if (!Array.isArray(next.triggers)) next.triggers = [];
		next.triggers.push(trigger);
		updateScriptTree(next);
	}

	function addScriptAction(listPath, index, action) {
		if (!scriptDraftParsed.value) return;
		updateScriptTree(applyScriptOp(scriptDraftParsed.value, listPath, 'insert', { index, value: action }));
	}

	function addScriptCondition(listPath, index) {
		addScriptAction(listPath, index, defaultActionForType('condition'));
	}

	function deleteScript() {
		if (!selectedKey) return;
		if (!window.confirm("Remove this script from the working copy? This can't be undone in the tool.")) return;
		setGameData((gd) => {
			const next = deepClone(gd);
			delete next.data.scripts[selectedKey];
			return next;
		});
		setSelectedKey(null);
		setScriptDraft(null);
	}

	function addScriptFolder(parentId) {
		const name = prompt('New script group name:');
		if (!name) return;
		const id = generateKey();
		setGameData((gd) => {
			const next = deepClone(gd);
			if (!next.data.scripts) next.data.scripts = {};
			next.data.scripts[id] = { key: id, folderName: name, parent: parentId ?? null, order: 0, expanded: true };
			return next;
		});
		setSelectedScriptFolderId(id);
	}

	function renameScriptFolder(id) {
		const node = scriptsCollection[id];
		const name = prompt('Rename group:', node?.folderName || '');
		if (!name) return;
		setGameData((gd) => {
			const next = deepClone(gd);
			next.data.scripts[id] = { ...next.data.scripts[id], folderName: name };
			return next;
		});
	}

	function deleteScriptFolder(id) {
		const node = scriptsCollection[id];
		if (!node) return;
		if (
			!window.confirm(
				`Delete the "${node.folderName}" group? Anything inside it (sub-groups, scripts) moves up to its parent group - nothing inside it gets deleted.`
			)
		)
			return;
		setGameData((gd) => {
			const next = deepClone(gd);
			const parentId = next.data.scripts[id]?.parent ?? null;
			Object.values(next.data.scripts).forEach((node) => {
				if ((node.parent ?? null) === id) node.parent = parentId;
			});
			delete next.data.scripts[id];
			return next;
		});
		if (selectedScriptFolderId === id) setSelectedScriptFolderId(null);
	}

	function moveScriptFolder(id, newParentId) {
		if (newParentId === id) return;
		if (isSelfOrDescendantScript(scriptsCollection, id, newParentId)) {
			alert("Can't move a group inside itself or one of its own sub-groups.");
			return;
		}
		setGameData((gd) => {
			const next = deepClone(gd);
			next.data.scripts[id] = { ...next.data.scripts[id], parent: newParentId };
			return next;
		});
	}

	function selectDialogue(key) {
		const d = dialoguesCollection[key];
		if (!d) return;
		setSelectedKey(key);
		setDialogueDraft({
			key,
			name: d.name || '',
			dialogueTitle: d.dialogueTitle || '',
			message: d.message || '',
			image: d.image || '',
			letterPrintSpeed: d.letterPrintSpeed ?? 0,
			options: deepClone(d.options) || [],
			isNew: false,
		});
		setSavedMsg('');
	}
	
	function startNewDialogue() {
		const id = generateKey();
		setSelectedKey(id);
		setDialogueDraft({
			key: id,
			name: 'New Dialogue',
			dialogueTitle: '',
			message: '',
			image: '',
			letterPrintSpeed: 0,
			options: [],
			isNew: true,
		});
		setSavedMsg('');
	}

	function updateDialogueField(field, value) {
		setDialogueDraft((d) => ({ ...d, [field]: value }));
	}

	function addDialogueOption() {
		setDialogueDraft((d) => ({
			...d,
			options: [...d.options, { name: 'New option', scriptName: '', followUpDialogue: '' }],
		}));
	}

	function updateDialogueOption(index, field, value) {
		setDialogueDraft((d) => {
			const options = [...d.options];
			options[index] = { ...options[index], [field]: value };
			return { ...d, options };
		});
	}

	function removeDialogueOption(index) {
		setDialogueDraft((d) => ({ ...d, options: d.options.filter((_, i) => i !== index) }));
	}

	function moveDialogueOption(index, direction) {
		setDialogueDraft((d) => {
			const options = [...d.options];
			const target = index + direction;
			if (target < 0 || target >= options.length) return d;
			[options[index], options[target]] = [options[target], options[index]];
			return { ...d, options };
		});
	}

	function saveDialogueDraft() {
		if (!dialogueDraft.dialogueTitle.trim() && !dialogueDraft.message.trim()) {
			if (!window.confirm('This dialogue has no title or message - save it anyway?')) return;
		}
		setGameData((gd) => {
			const next = deepClone(gd);
			if (!next.data.dialogues) next.data.dialogues = {};
			next.data.dialogues[dialogueDraft.key] = {
				name: dialogueDraft.name,
				dialogueTitle: dialogueDraft.dialogueTitle,
				message: dialogueDraft.message,
				image: dialogueDraft.image,
				letterPrintSpeed: Number(dialogueDraft.letterPrintSpeed) || 0,
				options: dialogueDraft.options,
				streamMode: next.data.dialogues[dialogueDraft.key]?.streamMode ?? 1,
			};
			return next;
		});
		setDialogueDraft((d) => ({ ...d, isNew: false }));
		setSavedMsg('Saved to the working copy in this tool. Download the file below to keep it.');
	}

	function deleteDialogue() {
		if (!selectedKey) return;
		if (
			!window.confirm(
				"Remove this dialogue from the working copy? Any other dialogue's \"then show\" or script's \"open dialogue\" action pointing at it would break - this tool can't find and fix those for you."
			)
		)
			return;
		setGameData((gd) => {
			const next = deepClone(gd);
			delete next.data.dialogues[selectedKey];
			return next;
		});
		setSelectedKey(null);
		setDialogueDraft(null);
	}

	function addFolder(parentId) {
		const name = prompt('New group name:');
		if (!name) return;
		const id = generateKey();
		setGameData((gd) => {
			const next = deepClone(gd);
			if (!next.data.folders) next.data.folders = {};
			next.data.folders[id] = { name, parent: parentId, type: 'folder', closed: false };
			return next;
		});
		setSelectedFolderId(id);
	}

	function renameFolder(id) {
		const current = folders[id];
		const name = prompt('Rename group:', current?.name || '');
		if (!name) return;
		setGameData((gd) => {
			const next = deepClone(gd);
			next.data.folders[id] = { ...next.data.folders[id], name };
			return next;
		});
	}

	// removing folders
	function deleteFolder(id) {
		const folder = folders[id];
		if (!folder) return;
		if (
			!window.confirm(
				`Delete the "${folder.name}" group? Anything inside it (sub-groups, units, items) moves up to its parent group - nothing inside it gets deleted.`
			)
		)
			return;
		setGameData((gd) => {
			const next = deepClone(gd);
			const parentId = next.data.folders[id]?.parent;
			Object.values(next.data.folders).forEach((node) => {
				if (node.parent === id) node.parent = parentId;
			});
			delete next.data.folders[id];
			return next;
		});
		if (selectedFolderId === id) setSelectedFolderId(null);
	}

	function moveFolder(id, newParentId) {
		if (newParentId === id) return;
		if (isSelfOrDescendant(folders, id, newParentId)) {
			alert("Can't move a group inside itself or one of its own sub-groups.");
			return;
		}
		setGameData((gd) => {
			const next = deepClone(gd);
			next.data.folders[id] = { ...next.data.folders[id], parent: newParentId };
			return next;
		});
	}

	function addAttributeType() {
		const name = prompt('New attribute name (e.g. Shield):');
		if (!name) return;
		const key = generateKey();
		setGameData((gd) => {
			const next = deepClone(gd);
			next.data.attributeTypes[key] = {
				name,
				min: 0,
				max: 100,
				value: 0,
				isVisible: true,
				displayValue: true,
				showAsHUD: false,
				color: 'white',
				decimalPlaces: 0,
			};
			return next;
		});
	}

	function updateAttributeType(key, field, value) {
		setGameData((gd) => {
			const next = deepClone(gd);
			next.data.attributeTypes[key] = { ...next.data.attributeTypes[key], [field]: value };
			return next;
		});
	}

	// player types aka teams
	function addPlayerType() {
		const name = prompt('New team/player type name:');
		if (!name) return;
		const key = generateKey();
		setGameData((gd) => {
			const next = deepClone(gd);
			if (!next.data.playerTypes) next.data.playerTypes = {};
			next.data.playerTypes[key] = {
				name,
				color: '#ffffff',
				showNameLabel: true,
				hideChatBubble: false,
				hideChatDistance: 0,
				attributes: {},
				variables: {},
				relationships: {},
			};
			return next;
		});
		setEditingPlayerTypeKey(key);
	}

	function updatePlayerTypeField(key, field, value) {
		setGameData((gd) => {
			const next = deepClone(gd);
			next.data.playerTypes[key] = { ...next.data.playerTypes[key], [field]: value };
			return next;
		});
	}

	function deletePlayerType(key) {
		if (!window.confirm('Delete this player type? Any relationships other teams have pointing to it will also be removed.')) return;
		setGameData((gd) => {
			const next = deepClone(gd);
			delete next.data.playerTypes[key];
			Object.values(next.data.playerTypes || {}).forEach((pt) => {
				if (pt.relationships) delete pt.relationships[key];
			});
			return next;
		});
		if (editingPlayerTypeKey === key) setEditingPlayerTypeKey(null);
	}

	function updatePlayerTypeRelationship(key, otherKey, value) {
		setGameData((gd) => {
			const next = deepClone(gd);
			const pt = next.data.playerTypes[key];
			pt.relationships = { ...(pt.relationships || {}), [otherKey]: value };
			return next;
		});
	}

	function addPlayerTypeAttribute(key, attrKey) {
		if (!attrKey) return;
		setGameData((gd) => {
			const next = deepClone(gd);
			const pt = next.data.playerTypes[key];
			const source = next.data.attributeTypes[attrKey] || {};
			pt.attributes = { ...(pt.attributes || {}), [attrKey]: { value: source.value ?? 0, min: source.min ?? 0, max: source.max ?? 100 } };
			return next;
		});
	}

	function removePlayerTypeAttribute(key, attrKey) {
		setGameData((gd) => {
			const next = deepClone(gd);
			const pt = next.data.playerTypes[key];
			const attrs = { ...(pt.attributes || {}) };
			delete attrs[attrKey];
			pt.attributes = attrs;
			return next;
		});
	}

	function updatePlayerTypeAttributeField(key, attrKey, field, value) {
		setGameData((gd) => {
			const next = deepClone(gd);
			const pt = next.data.playerTypes[key];
			pt.attributes[attrKey] = { ...pt.attributes[attrKey], [field]: value };
			return next;
		});
	}

	function addPlayerTypeVariable(key, varName) {
		if (!varName) return;
		setGameData((gd) => {
			const next = deepClone(gd);
			const pt = next.data.playerTypes[key];
			const source = (next.data.variables || {})[varName] || {};
			pt.variables = { ...(pt.variables || {}), [varName]: { default: source.default ?? '', dataType: source.dataType || 'string' } };
			return next;
		});
	}

	function removePlayerTypeVariable(key, varName) {
		setGameData((gd) => {
			const next = deepClone(gd);
			const pt = next.data.playerTypes[key];
			const vars = { ...(pt.variables || {}) };
			delete vars[varName];
			pt.variables = vars;
			return next;
		});
	}

	function addGlobalVariable() {
		const name = prompt('New global variable name:');
		if (!name) return;
		setGameData((gd) => {
			const next = deepClone(gd);
			if (!next.data.variables) next.data.variables = {};
			next.data.variables[name] = { default: '', dataType: 'string' };
			return next;
		});
	}

	function updateGlobalVariable(name, field, value) {
		setGameData((gd) => {
			const next = deepClone(gd);
			next.data.variables[name] = { ...next.data.variables[name], [field]: value };
			return next;
		});
	}

	function downloadJson() {
		const blob = new Blob([JSON.stringify(gameData)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = fileName || 'game.json';
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
	}

	const unusedAttributeKeys = draft
		? Object.keys(attributeTypes).filter((k) => !draft.attributes[k])
		: [];

	function FolderRow({ node, depth }) {
		const isCollapsed = collapsed[node.id];
		return (
			<div>
				<div
					className={`flex items-center gap-1 px-2 py-1.5 border-b border-[#323d48] group ${
						selectedFolderId === node.id ? 'bg-[#323d48]' : 'hover:bg-[#323d48]/50'
					}`}
					style={{ paddingLeft: 8 + depth * 14 }}
				>
					<button
						onClick={() => setCollapsed((c) => ({ ...c, [node.id]: !c[node.id] }))}
						className="text-[#8291a1] hover:text-[#c5ccd3] shrink-0"
					>
						{isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
					</button>
					<button
						onClick={() => setSelectedFolderId(node.id)}
						className="flex-1 text-left text-sm text-[#c5ccd3] truncate font-medium"
					>
						{node.name || '(unnamed group)'}
					</button>
					<div className="hidden group-hover:flex items-center gap-1 shrink-0">
						<button title="New sub-group" onClick={() => addFolder(node.id)} className="text-[#8291a1] hover:text-[#1a56da]">
							<FolderPlus size={13} />
						</button>
						<button title="Rename" onClick={() => renameFolder(node.id)} className="text-[#8291a1] hover:text-[#1a56da]">
							<Pencil size={13} />
						</button>
						<select
							title="Move to another group"
							value=""
							onChange={(e) => e.target.value && moveFolder(node.id, e.target.value)}
							className="bg-[#262e36] border border-[#3d4a57] rounded text-xs text-[#8291a1] max-w-[90px] focus:outline-none"
						>
							<option value="" disabled>
								Move to...
							</option>
							{folderOptions
								.filter((f) => f.id !== node.id)
								.map((f) => (
									<option key={f.id} value={f.id}>
										{'—'.repeat(f.depth)} {f.name}
									</option>
								))}
						</select>
						<button title="Delete group" onClick={() => deleteFolder(node.id)} className="text-[#8291a1] hover:text-red-400">
							<Trash2 size={13} />
						</button>
					</div>
				</div>
				{!isCollapsed && node.children.map((child) =>
					child.kind === 'folder' ? (
						<FolderRow key={child.id} node={child} depth={depth + 1} />
					) : (
						<button
							key={child.id}
							onClick={() => selectEntity(child.id)}
							style={{ paddingLeft: 8 + (depth + 1) * 14 + 17 }}
							className={`w-full text-left pr-3 py-2 border-b border-[#323d48] transition-colors ${
								selectedKey === child.id ? 'bg-[#323d48]' : 'hover:bg-[#323d48]/50'
							}`}
						>
							<div className="text-sm text-[#e1e6ea] truncate">{categoryMap[child.id]?.name || '(unnamed)'}</div>
							<div className="text-xs text-[#637588] font-mono truncate">{child.id}</div>
						</button>
					)
				)}
			</div>
		);
	}

	function ScriptFolderRow({ node, depth }) {
		const isCollapsed = scriptCollapsed[node.id];
		return (
			<div>
				<div
					className={`flex items-center gap-1 px-2 py-1.5 border-b border-[#323d48] group ${
						selectedScriptFolderId === node.id ? 'bg-[#323d48]' : 'hover:bg-[#323d48]/50'
					}`}
					style={{ paddingLeft: 8 + depth * 14 }}
				>
					<button
						onClick={() => setScriptCollapsed((c) => ({ ...c, [node.id]: !c[node.id] }))}
						className="text-[#8291a1] hover:text-[#c5ccd3] shrink-0"
					>
						{isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
					</button>
					<button
						onClick={() => setSelectedScriptFolderId(node.id)}
						className="flex-1 text-left text-sm text-[#c5ccd3] truncate font-medium"
					>
						{node.name || '(unnamed group)'}
					</button>
					<div className="hidden group-hover:flex items-center gap-1 shrink-0">
						<button title="New sub-group" onClick={() => addScriptFolder(node.id)} className="text-[#8291a1] hover:text-[#1a56da]">
							<FolderPlus size={13} />
						</button>
						<button title="Rename" onClick={() => renameScriptFolder(node.id)} className="text-[#8291a1] hover:text-[#1a56da]">
							<Pencil size={13} />
						</button>
						<select
							title="Move to another group"
							value=""
							onChange={(e) => e.target.value !== '' && moveScriptFolder(node.id, e.target.value === '__top__' ? null : e.target.value)}
							className="bg-[#262e36] border border-[#3d4a57] rounded text-xs text-[#8291a1] max-w-[90px] focus:outline-none"
						>
							<option value="" disabled>
								Move to...
							</option>
							{scriptFolderOptions
								.filter((f) => f.id !== node.id)
								.map((f) => (
									<option key={f.id ?? '__top__'} value={f.id ?? '__top__'}>
										{'—'.repeat(f.depth)} {f.name}
									</option>
								))}
						</select>
						<button title="Delete group" onClick={() => deleteScriptFolder(node.id)} className="text-[#8291a1] hover:text-red-400">
							<Trash2 size={13} />
						</button>
					</div>
				</div>
				{!isCollapsed &&
					node.children.map((child) =>
						child.kind === 'folder' ? (
							<ScriptFolderRow key={child.id} node={child} depth={depth + 1} />
						) : (
							<button
								key={child.id}
								onClick={() => selectScript(child.id)}
								style={{ paddingLeft: 8 + (depth + 1) * 14 + 17 }}
								className={`w-full text-left pr-3 py-2 border-b border-[#323d48] transition-colors ${
									selectedKey === child.id ? 'bg-[#323d48]' : 'hover:bg-[#323d48]/50'
								}`}
							>
								<div className="text-sm text-[#e1e6ea] truncate">{scriptsCollection[child.id]?.name || '(unnamed)'}</div>
								<div className="text-xs text-[#637588] truncate">
									{(scriptsCollection[child.id]?.triggers || []).map((t) => t.type).join(', ') || 'no triggers'}
								</div>
							</button>
						)
					)}
			</div>
		);
	}

	return (
		<div className="min-h-screen bg-[#262e36] text-[#e1e6ea] font-sans">
			<header className="border-b border-[#3d4a57] bg-[#323d48]/60 px-6 py-4 flex items-center justify-between sticky top-0 z-10">
				<div>
					<h1 className="text-lg font-semibold text-[#1a56da] tracking-tight">Content Editor</h1>
					<p className="text-xs text-[#8291a1] mt-0.5">Create and edit units, items, and projectiles outside the live editor</p>
				</div>
				<div className="flex items-center gap-2">
					{gameData && (
						<>
							<label className="text-xs text-[#8291a1] hidden md:inline" title="A domain where /sprites/... actually resolves to real image files - NOT the github.com webpage URL">
								Image server
							</label>
							<input
								value={assetBaseUrl}
								onChange={(e) => updateAssetBaseUrl(e.target.value)}
								placeholder="https://raw.githubusercontent.com/user/repo/main"
								title="Where images actually live, e.g. https://raw.githubusercontent.com/user/repo/main or your own game server's URL - not a github.com/.../tree/... page"
								className="hidden md:block w-64 bg-[#262e36] border border-[#3d4a57] rounded-md px-2 py-1.5 text-xs placeholder-[#48596a] focus:outline-none focus:border-[#1a56da] mr-1"
							/>
							<span className="text-xs text-[#8291a1] mr-2 hidden sm:inline">{fileName}</span>
						</>
					)}
					<button
						onClick={() => fileInputRef.current?.click()}
						className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-[#48596a] text-sm hover:bg-[#3d4a57] transition-colors"
					>
						<Upload size={14} /> {gameData ? 'Replace file' : 'Upload game.json'}
					</button>
					<input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={handleUpload} />
					{gameData && (
						<button
							onClick={downloadJson}
							className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[#1a56da] text-[#262e36] text-sm font-medium hover:bg-[#1a56da] transition-colors"
						>
							<Download size={14} /> Download
						</button>
					)}
				</div>
			</header>

			{fileError && (
				<div className="mx-6 mt-4 flex items-start gap-2 rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-300">
					<AlertCircle size={16} className="mt-0.5 shrink-0" /> {fileError}
				</div>
			)}

			{!gameData ? (
				<div className="flex flex-col items-center justify-center py-32 text-center px-6">
					<div className="w-14 h-14 rounded-full border border-[#48596a] flex items-center justify-center mb-4">
						<Upload size={22} className="text-[#8291a1]" />
					</div>
					<p className="text-[#a3adb8] max-w-sm text-sm">
						Upload your game.json to start browsing, editing, or creating units, items, and projectiles.
					</p>
				</div>
			) : (
				<div className="flex" style={{ minHeight: 'calc(100vh - 73px)' }}>
					{/* Tab rail */}
					<nav className="w-40 shrink-0 border-r border-[#3d4a57] py-4">
						<div className="px-4 text-xs uppercase tracking-wide text-[#637588] mb-1.5">Entities</div>
						{ENTITY_TABS.map((t) => (
							<button
								key={t.key}
								onClick={() => {
									setActiveTab(t.key);
									setSelectedKey(null);
									setSelectedFolderId(null);
									setDraft(null);
									setGroupDraft(null);
									setSearch('');
								}}
								className={`w-full text-left px-4 py-1.5 text-sm border-l-2 transition-colors ${
									activeTab === t.key
										? 'border-[#1a56da] text-[#1a56da] bg-[#323d48]'
										: 'border-transparent text-[#a3adb8] hover:text-[#e1e6ea] hover:bg-[#323d48]/50'
								}`}
							>
								{t.label}
								<span className="text-[#637588] ml-1.5 text-xs">{Object.keys(gameData?.data?.[t.key] || {}).length}</span>
							</button>
						))}
						<div className="px-4 text-xs uppercase tracking-wide text-[#637588] mt-5 mb-1.5">Reference</div>
						{REFERENCE_TABS.map((t) => (
							<button
								key={t.key}
								onClick={() => {
									setActiveTab(t.key);
									setSelectedKey(null);
									setDraft(null);
									setGroupDraft(null);
									setSearch('');
								}}
								className={`w-full text-left px-4 py-1.5 text-sm border-l-2 transition-colors ${
									activeTab === t.key
										? 'border-[#1a56da] text-[#1a56da] bg-[#323d48]'
										: 'border-transparent text-[#a3adb8] hover:text-[#e1e6ea] hover:bg-[#323d48]/50'
								}`}
							>
								{t.label}
							</button>
						))}
						{GROUP_TABS.map((t) => (
							<button
								key={t.key}
								onClick={() => {
									setActiveTab(t.key);
									setSelectedKey(null);
									setDraft(null);
									setGroupDraft(null);
									setSearch('');
								}}
								className={`w-full text-left px-4 py-1.5 text-sm border-l-2 transition-colors ${
									activeTab === t.key
										? 'border-[#1a56da] text-[#1a56da] bg-[#323d48]'
										: 'border-transparent text-[#a3adb8] hover:text-[#e1e6ea] hover:bg-[#323d48]/50'
								}`}
							>
								{t.label}
								<span className="text-[#637588] ml-1.5 text-xs">
									{Object.values(gameData?.data?.variables || {}).filter((v) => v?.dataType === t.dataType).length}
								</span>
							</button>
						))}
						<div className="px-4 text-xs uppercase tracking-wide text-[#637588] mt-5 mb-1.5">Scripts</div>
						<button
							onClick={() => {
								setActiveTab('globalScripts');
								setSelectedKey(null);
								setSelectedScriptFolderId(null);
								setScriptDraft(null);
								setSearch('');
							}}
							className={`w-full text-left px-4 py-1.5 text-sm border-l-2 transition-colors ${
								activeTab === 'globalScripts'
									? 'border-[#1a56da] text-[#1a56da] bg-[#323d48]'
									: 'border-transparent text-[#a3adb8] hover:text-[#e1e6ea] hover:bg-[#323d48]/50'
							}`}
						>
							Global scripts
							<span className="text-[#637588] ml-1.5 text-xs">
								{Object.values(scriptsCollection).filter((v) => 'triggers' in v).length}
							</span>
						</button>
						<button
							onClick={() => {
								setActiveTab('dialogues');
								setSelectedKey(null);
								setDialogueDraft(null);
								setSearch('');
							}}
							className={`w-full text-left px-4 py-1.5 text-sm border-l-2 transition-colors ${
								activeTab === 'dialogues'
									? 'border-[#1a56da] text-[#1a56da] bg-[#323d48]'
									: 'border-transparent text-[#a3adb8] hover:text-[#e1e6ea] hover:bg-[#323d48]/50'
							}`}
						>
							Dialogues
							<span className="text-[#637588] ml-1.5 text-xs">{Object.keys(dialoguesCollection).length}</span>
						</button>
					</nav>

					{isEntityTab ? (
						<>
							{/* List pane */}
							<div className="w-64 shrink-0 border-r border-[#3d4a57] flex flex-col">
								<div className="p-3 border-b border-[#3d4a57]">
									<div className="relative">
										<Search size={13} className="absolute left-2.5 top-2.5 text-[#637588]" />
										<input
											value={search}
											onChange={(e) => setSearch(e.target.value)}
											placeholder="Search..."
											className="w-full bg-[#323d48] border border-[#48596a] rounded-md pl-8 pr-2 py-1.5 text-sm placeholder-[#637588] focus:outline-none focus:border-[#1a56da]"
										/>
									</div>
									<div className="flex gap-1.5 mt-2">
										<button
											onClick={() => setShowNewModal(true)}
											className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md border border-dashed border-[#48596a] text-sm text-[#a3adb8] hover:border-[#1a56da] hover:text-[#1a56da] transition-colors"
										>
											<Plus size={14} /> New {ENTITY_TABS.find((t) => t.key === activeTab)?.label.slice(0, -1)}
										</button>
										<button
											title="New group"
											onClick={() => addFolder(selectedFolderId || activeTabDef.root)}
											className="flex items-center justify-center px-2.5 py-1.5 rounded-md border border-dashed border-[#48596a] text-[#a3adb8] hover:border-[#1a56da] hover:text-[#1a56da] transition-colors"
										>
											<FolderPlus size={14} />
										</button>
									</div>
									{selectedFolderId && !search.trim() && (
										<div className="text-xs text-[#637588] mt-1.5 truncate">
											New items go into: <span className="text-[#a3adb8]">{folders[selectedFolderId]?.name || 'root'}</span>
										</div>
									)}
								</div>
								<div className="flex-1 overflow-y-auto">
									{search.trim() ? (
										<>
											{filteredEntries.map(([key, entity]) => (
												<button
													key={key}
													onClick={() => selectEntity(key)}
													className={`w-full text-left px-3 py-2 border-b border-[#323d48] transition-colors ${
														selectedKey === key ? 'bg-[#323d48]' : 'hover:bg-[#323d48]/50'
													}`}
												>
													<div className="text-sm text-[#e1e6ea] truncate">{entity?.name || '(unnamed)'}</div>
													<div className="text-xs text-[#637588] font-mono truncate">{key}</div>
												</button>
											))}
											{filteredEntries.length === 0 && (
												<div className="text-sm text-[#637588] text-center py-8 px-4">No matches.</div>
											)}
										</>
									) : (
										<>
											{tree.map((node) =>
												node.kind === 'folder' ? (
													<FolderRow key={node.id} node={node} depth={0} />
												) : (
													<button
														key={node.id}
														onClick={() => selectEntity(node.id)}
														className={`w-full text-left px-3 py-2 border-b border-[#323d48] transition-colors ${
															selectedKey === node.id ? 'bg-[#323d48]' : 'hover:bg-[#323d48]/50'
														}`}
													>
														<div className="text-sm text-[#e1e6ea] truncate">{categoryMap[node.id]?.name || '(unnamed)'}</div>
														<div className="text-xs text-[#637588] font-mono truncate">{node.id}</div>
													</button>
												)
											)}
											{tree.length === 0 && (
												<div className="text-sm text-[#637588] text-center py-8 px-4">Nothing here yet.</div>
											)}
										</>
									)}
								</div>
							</div>

							{/* Editor pane */}
							<div className="flex-1 overflow-y-auto p-6">
								{!draft ? (
									<div className="text-[#637588] text-sm mt-16 text-center">
										Select an entry on the left, or create a new one.
									</div>
								) : (
									<div className="max-w-2xl">
										<div className="flex items-center justify-between mb-4">
											<div>
												<input
													value={draft.name}
													onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
													className="text-xl font-semibold bg-transparent border-b border-transparent hover:border-[#48596a] focus:border-[#1a56da] focus:outline-none px-0.5"
												/>
												<div className="text-xs text-[#637588] font-mono mt-1">
													{draft.key} {draft.isNew && <span className="text-[#1a56da] ml-1">(new, not saved yet)</span>}
												</div>
											</div>
											<div className="flex gap-2">
												{!draft.isNew && (
													<button
														onClick={deleteEntity}
														className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-red-900 text-red-400 text-sm hover:bg-red-950/40 transition-colors"
													>
														<Trash2 size={13} /> Delete
													</button>
												)}
												<button
													onClick={saveDraft}
													className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[#1a56da] text-[#262e36] text-sm font-medium hover:bg-[#1a56da] transition-colors"
												>
													<Save size={13} /> Save to working copy
												</button>
											</div>
										</div>

										<div className="mb-6 flex items-center gap-2">
											<span className="text-xs text-[#8291a1] shrink-0">Group</span>
											<select
												value={draft.folderId}
												onChange={(e) => setDraft((d) => ({ ...d, folderId: e.target.value }))}
												className="bg-[#323d48] border border-[#3d4a57] rounded-md px-2 py-1 text-sm focus:outline-none focus:border-[#1a56da]"
											>
												{folderOptions.map((f) => (
													<option key={f.id} value={f.id}>
														{'—'.repeat(f.depth)} {f.name}
													</option>
												))}
											</select>
										</div>

										{savedMsg && (
											<div className="mb-5 text-sm text-emerald-400 bg-emerald-950/30 border border-emerald-900 rounded-md px-3 py-2">
												{savedMsg}
											</div>
										)}

										{/* Attributes */}
										<section className="mb-7">
											<h3 className="text-sm font-medium text-[#c5ccd3] mb-2">Attributes</h3>
											<div className="space-y-2">
												{Object.entries(draft.attributes).map(([attrKey, attr]) => (
													<div key={attrKey} className="flex items-center gap-2 bg-[#323d48] border border-[#3d4a57] rounded-md px-3 py-2">
														<span className="text-sm flex-1 truncate">{attributeTypes[attrKey]?.name || attrKey}</span>
														<label className="text-xs text-[#8291a1]">value</label>
														<input
															type="number"
															value={attr.value}
															onChange={(e) => updateAttributeField(attrKey, 'value', Number(e.target.value))}
															className="w-16 bg-[#262e36] border border-[#3d4a57] rounded px-1.5 py-0.5 text-sm"
														/>
														<label className="text-xs text-[#8291a1]">min</label>
														<input
															type="number"
															value={attr.min}
															onChange={(e) => updateAttributeField(attrKey, 'min', Number(e.target.value))}
															className="w-14 bg-[#262e36] border border-[#3d4a57] rounded px-1.5 py-0.5 text-sm"
														/>
														<label className="text-xs text-[#8291a1]">max</label>
														<input
															type="number"
															value={attr.max}
															onChange={(e) => updateAttributeField(attrKey, 'max', Number(e.target.value))}
															className="w-16 bg-[#262e36] border border-[#3d4a57] rounded px-1.5 py-0.5 text-sm"
														/>
														<button onClick={() => removeAttribute(attrKey)} className="text-[#637588] hover:text-red-400 ml-1">
															<X size={14} />
														</button>
													</div>
												))}
											</div>
											{unusedAttributeKeys.length > 0 && (
												<select
													onChange={(e) => {
														addAttribute(e.target.value);
														e.target.value = '';
													}}
													defaultValue=""
													className="mt-2 bg-[#323d48] border border-dashed border-[#48596a] rounded-md px-2 py-1.5 text-sm text-[#a3adb8] w-full focus:outline-none focus:border-[#1a56da]"
												>
													<option value="" disabled>+ Attach an existing attribute...</option>
													{unusedAttributeKeys.map((k) => (
														<option key={k} value={k}>{attributeTypes[k]?.name || k}</option>
													))}
												</select>
											)}
										</section>

										{activeTab === 'unitTypes' && (
							/* Unit inventory */
							<section className="mb-7">
								<h3 className="text-sm font-medium text-[#c5ccd3] mb-2">Inventory</h3>
								<div className="flex items-center gap-3 mb-3">
									<div>
										<label className="block text-xs text-[#8291a1] mb-1">Inventory slots</label>
										<input
											type="number"
											min="0"
											max="9"
											value={draft.inventorySize ?? 1}
											onChange={(e) => {
												const value = Math.min(9, Math.max(0, Number(e.target.value) || 0));
												setDraft((d) => ({ ...d, inventorySize: value }));
											}}
											className="w-24 bg-[#323d48] border border-[#3d4a57] rounded px-2 py-1 text-sm"
										/>
									</div>
									<p className="text-xs text-[#637588] max-w-[20rem] mt-4">
										Maximum 9 slots. Default items below are added to this unit automatically.
									</p>
								</div>

								<div className="space-y-2">
									{(draft.defaultItems || []).map((entry, index) => (
										<div key={`${entry.key || 'item'}-${index}`} className="flex items-center gap-2 bg-[#323d48] border border-[#3d4a57] rounded-md px-3 py-2">
											<span className="text-xs text-[#8291a1] w-5 shrink-0">{index + 1}</span>
											<select
												value={entry.key || ''}
												onChange={(e) => {
													const itemKey = e.target.value;
													const item = itemTypes[itemKey];
													if (!item) return;
													setDraft((d) => {
														const next = [...(d.defaultItems || [])];
														next[index] = { key: itemKey, value: item.name || itemKey, name: item.name || itemKey };
														return { ...d, defaultItems: next };
													});
												}}
												className="flex-1 bg-[#262e36] border border-[#3d4a57] rounded px-2 py-1 text-sm"
											>
												<option value="" disabled>Choose an item...</option>
												{Object.entries(itemTypes)
													.sort((a, b) => (a[1]?.name || '').localeCompare(b[1]?.name || ''))
													.map(([itemKey, item]) => (
														<option key={itemKey} value={itemKey}>
															{item?.name || itemKey}
														</option>
													))}
											</select>
											<span className="text-xs text-[#637588] font-mono truncate max-w-[10rem]">{entry.key}</span>
											<button onClick={() => removeDefaultItem(index)} className="text-[#637588] hover:text-red-400 ml-1">
												<X size={14} />
											</button>
										</div>
									))}
								</div>
								<select
									onChange={(e) => {
									addDefaultItem(e.target.value);
									e.target.value = '';
								}}
									defaultValue=""
									className="mt-2 bg-[#323d48] border border-dashed border-[#48596a] rounded-md px-2 py-1.5 text-sm text-[#a3adb8] w-full focus:outline-none focus:border-[#1a56da]"
								>
									<option value="" disabled>+ Add an item...</option>
									{Object.entries(itemTypes)
										.sort((a, b) => (a[1]?.name || '').localeCompare(b[1]?.name || ''))
										.map(([itemKey, item]) => (
											<option key={itemKey} value={itemKey}>
												{item?.name || itemKey}
											</option>
										))}
									</select>
							</section>
						)}



						{activeTab === 'unitTypes' && (
							<section className="mb-7">
								<h3 className="text-sm font-medium text-[#c5ccd3] mb-2">Sounds</h3>
								<p className="text-[11px] text-[#637588] mb-3">Assign sounds from the global Sounds tab. Unit create/destroy sounds are stored in <span className="font-mono">effects.create.sound</span> and <span className="font-mono">effects.destroy.sound</span>.</p>
								{[['create','Create'],['destroy','Destroy']].map(([eventName,label]) => {
									const selectedSounds = draft.effects?.[eventName]?.sound || {};
									const selectedKeys = Object.keys(selectedSounds);
									return (
										<div key={eventName} className="mb-3 p-2.5 bg-[#323d48] border border-[#3d4a57] rounded-md">
											<div className="text-xs text-[#a3adb8] mb-2">{label}</div>
											{selectedKeys.length > 0 && <div className="flex flex-wrap gap-1.5 mb-2">{selectedKeys.map((soundKey) => <div key={soundKey} className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[#262e36] border border-[#3d4a57] text-xs"><span className="truncate max-w-[15rem]">{selectedSounds[soundKey]?.name || soundTypes[soundKey]?.name || soundKey}</span><button onClick={() => removeEntityEffectSound(eventName, soundKey)} className="text-[#8291a1] hover:text-red-400"><X size={12} /></button></div>)}</div>}
											<select defaultValue="" onChange={(e) => { const key=e.target.value; if(key) updateEntityEffectSound(eventName,key,true); e.target.value=''; }} className="w-full bg-[#262e36] border border-dashed border-[#48596a] rounded px-2 py-1.5 text-xs"><option value="" disabled>+ Add a sound...</option>{Object.entries(soundTypes).sort((a,b)=>(a[1]?.name||'').localeCompare(b[1]?.name||'')).filter(([key])=>!selectedKeys.includes(key)).map(([key,sound])=><option key={key} value={key}>{sound?.name || key}</option>)}</select>
										</div>
									);
								})}
							</section>
						)}

						{activeTab === 'itemTypes' && (
							<section className="mb-7">
								<h3 className="text-sm font-medium text-[#c5ccd3] mb-2">Item details</h3>
								<div className="grid grid-cols-2 gap-3 mb-3">
									<div>
										<label className="block text-xs text-[#8291a1] mb-1">Item type</label>
										<select value={draft.type || ''} onChange={(e) => updateDraftField('type', e.target.value)} className="w-full bg-[#323d48] border border-[#3d4a57] rounded px-2 py-1 text-sm">
											<option value="">(unset)</option><option value="weapon">weapon</option><option value="consumable">consumable</option><option value="unusable">unusable</option>
										</select>
									</div>
									<div>
										<label className="block text-xs text-[#8291a1] mb-1">Use delay / cooldown</label>
										<input type="number" min="0" value={draft.delayBeforeUse ?? 0} onChange={(e) => updateDraftField('delayBeforeUse', Number(e.target.value) || 0)} className="w-full bg-[#323d48] border border-[#3d4a57] rounded px-2 py-1 text-sm" />
									</div>
									<div>
										<label className="block text-xs text-[#8291a1] mb-1">Default quantity</label>
										<input type="number" min="0" value={draft.quantity ?? ''} onChange={(e) => updateDraftField('quantity', e.target.value === '' ? null : Math.max(0, Number(e.target.value) || 0))} className="w-full bg-[#323d48] border border-[#3d4a57] rounded px-2 py-1 text-sm" />
									</div>
									<div>
										<label className="block text-xs text-[#8291a1] mb-1">Max quantity</label>
										<input type="number" min="0" placeholder="∞" value={draft.maxQuantity ?? ''} onChange={(e) => updateDraftField('maxQuantity', e.target.value === '' ? null : Math.max(0, Number(e.target.value) || 0))} className="w-full bg-[#323d48] border border-[#3d4a57] rounded px-2 py-1 text-sm" />
										<p className="text-[11px] text-[#637588] mt-1">Blank means infinite.</p>
									</div>
									<div>
										<label className="block text-xs text-[#8291a1] mb-1">Fire rate</label>
										<input type="number" min="0" value={draft.fireRate ?? 0} onChange={(e) => updateDraftField('fireRate', Number(e.target.value) || 0)} className="w-full bg-[#323d48] border border-[#3d4a57] rounded px-2 py-1 text-sm" />
										<label className="mt-3 flex items-center gap-2 text-sm cursor-pointer">
											<input type="checkbox" checked={!!draft.showCDOverlay} onChange={(e) => updateDraftField('showCDOverlay', e.target.checked)} />
											<span>Show visual cooldown overlay</span>
										</label>
										<div className="mt-1 text-xs text-[#637588]">Uses the engine's <span className="font-mono">showCDOverlay</span> setting with <span className="font-mono">fireRate</span> to display the item's in-game cooldown overlay.</div>
										<label className="block mt-3 text-xs text-[#aab7c4]">Knockback force</label>
										<input type="number" value={draft.knockbackForce ?? 0} onChange={(e) => updateDraftField('knockbackForce', Number(e.target.value) || 0)} className="w-full bg-[#323d48] border border-[#3d4a57] rounded px-2 py-1 text-sm" />
										<div className="mt-1 text-xs text-[#637588]">Positive values push the affected unit backward; negative values push it forward.</div>
									</div>
									<div>
										<label className="block text-xs text-[#8291a1] mb-1">Reload rate</label>
										<input type="number" min="0" value={draft.reloadRate ?? 0} onChange={(e) => updateDraftField('reloadRate', Number(e.target.value) || 0)} className="w-full bg-[#323d48] border border-[#3d4a57] rounded px-2 py-1 text-sm" />
									</div>
									<div className="col-span-2">
										<label className="block text-xs text-[#8291a1] mb-1">Inventory icon URL</label>
										<input value={draft.inventoryImage || ''} onChange={(e) => updateDraftField('inventoryImage', e.target.value)} placeholder="/sprites/...png" className="w-full bg-[#323d48] border border-[#3d4a57] rounded px-2 py-1 text-sm" />
									</div>
									<div className="col-span-2">
										<label className="block text-xs text-[#8291a1] mb-1">Item description</label>
										<textarea rows={3} value={draft.description || ''} onChange={(e) => updateDraftField('description', e.target.value)} className="w-full bg-[#323d48] border border-[#3d4a57] rounded px-2 py-1 text-sm" />
									</div>
								</div>

								<div className="grid grid-cols-2 gap-3 mb-4">
									<label className="flex items-center gap-2 text-sm text-[#c5ccd3]"><input type="checkbox" checked={!!draft.isStackable} onChange={(e) => updateDraftField('isStackable', e.target.checked)} /> Stackable</label>
									<label className="flex items-center gap-2 text-sm text-[#c5ccd3]"><input type="checkbox" checked={!!draft.isPurchasable} onChange={(e) => updateDraftField('isPurchasable', e.target.checked)} /> Purchasable</label>
								</div>

								<div className="mb-4">
									<h4 className="text-xs font-medium text-[#a3adb8] mb-2">Can be carried by</h4>
									<div className="flex flex-wrap gap-1.5 mb-2">
										{(draft.carriedBy || []).map((id) => <span key={id} className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[#323d48] border border-[#3d4a57] text-xs">{groupMemberCollection?.[id]?.name || categoryMap?.[id]?.name || gameData.data.unitTypes?.[id]?.name || id}<button onClick={() => setDraft((d) => ({...d, carriedBy:(d.carriedBy||[]).filter(x=>x!==id)}))} className="text-[#8291a1] hover:text-red-400">×</button></span>)}
									</div>
									<select defaultValue="" onChange={(e) => { const id=e.target.value; if(!id)return; setDraft(d=>({...d,carriedBy:Array.from(new Set([...(d.carriedBy||[]),id]))})); e.target.value=''; }} className="w-full bg-[#323d48] border border-dashed border-[#48596a] rounded px-2 py-1.5 text-sm"><option value="" disabled>+ Add a unit...</option>{Object.entries(gameData.data.unitTypes||{}).sort((a,b)=>(a[1]?.name||'').localeCompare(b[1]?.name||'')).map(([id,v])=><option key={id} value={id}>{v?.name||id}</option>)}</select>
								</div>

								<div className="mb-4">
									<h4 className="text-xs font-medium text-[#a3adb8] mb-2">Can be used by</h4>
									<div className="flex flex-wrap gap-1.5 mb-2">
										{(draft.canBeUsedBy || []).map((id) => <span key={id} className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[#323d48] border border-[#3d4a57] text-xs">{gameData.data.unitTypes?.[id]?.name || id}<button onClick={() => setDraft((d) => ({...d, canBeUsedBy:(d.canBeUsedBy||[]).filter(x=>x!==id)}))} className="text-[#8291a1] hover:text-red-400">×</button></span>)}
									</div>
									<select defaultValue="" onChange={(e) => { const id=e.target.value; if(!id)return; setDraft(d=>({...d,canBeUsedBy:Array.from(new Set([...(d.canBeUsedBy||[]),id]))})); e.target.value=''; }} className="w-full bg-[#323d48] border border-dashed border-[#48596a] rounded px-2 py-1.5 text-sm"><option value="" disabled>+ Add a unit...</option>{Object.entries(gameData.data.unitTypes||{}).sort((a,b)=>(a[1]?.name||'').localeCompare(b[1]?.name||'')).map(([id,v])=><option key={id} value={id}>{v?.name||id}</option>)}</select>
								</div>

								<div className="mb-4">
									<h4 className="text-xs font-medium text-[#a3adb8] mb-2">Permitted inventory slots</h4>
									<div className="flex flex-wrap gap-2">{Array.from({length:9},(_,i)=>i+1).map(slot=><label key={slot} className="text-xs text-[#c5ccd3] flex items-center gap-1"><input type="checkbox" checked={(draft.controls?.permittedInventorySlots||[]).includes(slot)} onChange={(e)=>{const cur=draft.controls?.permittedInventorySlots||[]; const next=e.target.checked?Array.from(new Set([...cur,slot])):cur.filter(x=>x!==slot); updateDraftNestedField('controls','permittedInventorySlots',next.sort((a,b)=>a-b));}} /> {slot}</label>)}</div>
								</div>

								<div className="mb-4">
									<h4 className="text-xs font-medium text-[#a3adb8] mb-2">Projectile type</h4>
									<select value={draft.projectileType || ''} onChange={(e)=>updateDraftField('projectileType',e.target.value)} className="w-full bg-[#323d48] border border-[#3d4a57] rounded px-2 py-1.5 text-sm"><option value="">(none)</option>{Object.entries(gameData.data.projectileTypes||{}).sort((a,b)=>(a[1]?.name||'').localeCompare(b[1]?.name||'')).map(([id,v])=><option key={id} value={id}>{v?.name||id} ({id})</option>)}</select>
								</div>

								<div className="grid grid-cols-2 gap-4">
									<div>
										<h4 className="text-xs font-medium text-[#a3adb8] mb-2">Cost</h4>
										<div className="space-y-2">
											<div><label className="block text-[11px] text-[#637588] mb-1">Item quantity</label><input type="number" min="0" value={draft.cost?.quantity ?? 0} onChange={(e)=>updateDraftNestedField('cost','quantity',Math.max(0,Number(e.target.value)||0))} className="w-full bg-[#323d48] border border-[#3d4a57] rounded px-2 py-1 text-sm" /></div>
											<div><label className="block text-[11px] text-[#637588] mb-1">Unit attributes</label>{Object.entries(draft.costUnitAttributes || {}).map(([k,v])=><div key={k} className="flex gap-1 mb-1"><span className="flex-1 text-xs truncate">{playerAttributeTypes[k]?.name||k}</span><input type="number" value={v} onChange={(e)=>updateMappedValue('costUnitAttributes',k,Number(e.target.value)||0)} className="w-20 bg-[#262e36] border border-[#3d4a57] rounded px-1 py-0.5 text-xs" /><button onClick={()=>removeMappedValue('costUnitAttributes',k)} className="text-[#8291a1]">×</button></div>)}<select defaultValue="" onChange={(e)=>{const k=e.target.value;if(k)addMappedValue('costUnitAttributes',k,0);e.target.value='';}} className="w-full bg-[#323d48] border border-dashed border-[#48596a] rounded px-2 py-1 text-xs"><option value="" disabled>+ Add attribute...</option>{Object.entries(playerAttributeTypes).filter(([k])=>!draft.costUnitAttributes?.[k]).sort((a,b)=>(a[1]?.name||'').localeCompare(b[1]?.name||'')).map(([k,v])=><option key={k} value={k}>{v?.name||k}</option>)}</select></div>
											<div><label className="block text-[11px] text-[#637588] mb-1">Player attributes</label>{Object.entries(draft.costPlayerAttributes || {}).map(([k,v])=><div key={k} className="flex gap-1 mb-1"><span className="flex-1 text-xs truncate">{playerAttributeTypes[k]?.name||k}</span><input type="number" value={v} onChange={(e)=>updateMappedValue('costPlayerAttributes',k,Number(e.target.value)||0)} className="w-20 bg-[#262e36] border border-[#3d4a57] rounded px-1 py-0.5 text-xs" /><button onClick={()=>removeMappedValue('costPlayerAttributes',k)} className="text-[#8291a1]">×</button></div>)}<select defaultValue="" onChange={(e)=>{const k=e.target.value;if(k)addMappedValue('costPlayerAttributes',k,0);e.target.value='';}} className="w-full bg-[#323d48] border border-dashed border-[#48596a] rounded px-2 py-1 text-xs"><option value="" disabled>+ Add attribute...</option>{Object.entries(playerAttributeTypes).filter(([k])=>!draft.costPlayerAttributes?.[k]).sort((a,b)=>(a[1]?.name||'').localeCompare(b[1]?.name||'')).map(([k,v])=><option key={k} value={k}>{v?.name||k}</option>)}</select></div>
										</div>
									</div>

									<div>
										<h4 className="text-xs font-medium text-[#a3adb8] mb-2">Damage</h4>
										<div className="space-y-2">
											<div><label className="block text-[11px] text-[#637588] mb-1">Unit attributes</label>{Object.entries(draft.damageUnitAttributes || {}).map(([k,v])=><div key={k} className="flex gap-1 mb-1"><span className="flex-1 text-xs truncate">{playerAttributeTypes[k]?.name||k}</span><input value={v} onChange={(e)=>updateMappedValue('damageUnitAttributes',k,e.target.value)} className="w-20 bg-[#262e36] border border-[#3d4a57] rounded px-1 py-0.5 text-xs" /><button onClick={()=>removeMappedValue('damageUnitAttributes',k)} className="text-[#8291a1]">×</button></div>)}<select defaultValue="" onChange={(e)=>{const k=e.target.value;if(k)addMappedValue('damageUnitAttributes',k,0);e.target.value='';}} className="w-full bg-[#323d48] border border-dashed border-[#48596a] rounded px-2 py-1 text-xs"><option value="" disabled>+ Add attribute...</option>{Object.entries(playerAttributeTypes).filter(([k])=>!draft.damageUnitAttributes?.[k]).sort((a,b)=>(a[1]?.name||'').localeCompare(b[1]?.name||'')).map(([k,v])=><option key={k} value={k}>{v?.name||k}</option>)}</select></div>
											<div><label className="block text-[11px] text-[#637588] mb-1">Player attributes</label>{Object.entries(draft.damagePlayerAttributes || {}).map(([k,v])=><div key={k} className="flex gap-1 mb-1"><span className="flex-1 text-xs truncate">{playerAttributeTypes[k]?.name||k}</span><input value={v} onChange={(e)=>updateMappedValue('damagePlayerAttributes',k,e.target.value)} className="w-20 bg-[#262e36] border border-[#3d4a57] rounded px-1 py-0.5 text-xs" /><button onClick={()=>removeMappedValue('damagePlayerAttributes',k)} className="text-[#8291a1]">×</button></div>)}<select defaultValue="" onChange={(e)=>{const k=e.target.value;if(k)addMappedValue('damagePlayerAttributes',k,0);e.target.value='';}} className="w-full bg-[#323d48] border border-dashed border-[#48596a] rounded px-2 py-1 text-xs"><option value="" disabled>+ Add attribute...</option>{Object.entries(playerAttributeTypes).filter(([k])=>!draft.damagePlayerAttributes?.[k]).sort((a,b)=>(a[1]?.name||'').localeCompare(b[1]?.name||'')).map(([k,v])=><option key={k} value={k}>{v?.name||k}</option>)}</select></div>
											<div><label className="block text-[11px] text-[#637588] mb-1">Who can be hit</label><div className="flex flex-wrap gap-x-3 gap-y-1">{[['hostile','Hostile players'],['neutral','Neutral players'],['friendly','Friendly players'],['other','Everyone except holder']].map(([id,label])=><label key={id} className="text-xs text-[#c5ccd3] flex items-center gap-1"><input type="checkbox" checked={(draft.damage?.targetsAffected||[]).includes(id)} onChange={()=>toggleDamageTarget(id)} /> {label}</label>)}</div><p className="text-[11px] text-[#637588] mt-1">The editor stores these in the item's targetsAffected list.</p></div>
										</div>
								</div>

								</div>

							<div className="mt-5">
								<h4 className="text-xs font-medium text-[#a3adb8] mb-2">Sounds</h4>
								<p className="text-[11px] text-[#637588] mb-3">Assign sounds from the global Sounds tab. This game.json uses <span className="font-mono">effects.use.sound</span>, <span className="font-mono">effects.create.sound</span>, and <span className="font-mono">effects.destroy.sound</span>; there are no separate pickup/drop fields in the current schema, so Create/Destroy are presented here as the world-item drop/pickup counterparts.</p>
								{[['use','Use'],['create','Create / drop into world'],['destroy','Destroy / pick up from world']].map(([eventName,label]) => {
									const selectedSounds = draft.effects?.[eventName]?.sound || {};
									const selectedKeys = Object.keys(selectedSounds);
									return (
										<div key={eventName} className="mb-3 p-2.5 bg-[#323d48] border border-[#3d4a57] rounded-md">
											<div className="text-xs text-[#a3adb8] mb-2">{label}</div>
											{selectedKeys.length > 0 && <div className="flex flex-wrap gap-1.5 mb-2">{selectedKeys.map((soundKey) => <div key={soundKey} className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[#262e36] border border-[#3d4a57] text-xs"><span className="truncate max-w-[15rem]">{selectedSounds[soundKey]?.name || soundTypes[soundKey]?.name || soundKey}</span><button onClick={() => removeItemEffectSound(eventName, soundKey)} className="text-[#8291a1] hover:text-red-400"><X size={12} /></button></div>)}</div>}
											<select defaultValue="" onChange={(e) => { const key=e.target.value; if(key) updateItemEffectSound(eventName,key,true); e.target.value=''; }} className="w-full bg-[#262e36] border border-dashed border-[#48596a] rounded px-2 py-1.5 text-xs"><option value="" disabled>+ Add a sound...</option>{Object.entries(soundTypes).sort((a,b)=>(a[1]?.name||'').localeCompare(b[1]?.name||'')).filter(([key])=>!selectedKeys.includes(key)).map(([key,sound])=><option key={key} value={key}>{sound?.name || key}</option>)}</select>
										</div>
									);
								})}
							</div>
							<div className="mt-4 p-2.5 rounded-md border border-[#3d4a57] bg-[#323d48]/50 text-xs text-[#637588]">"Use delay / cooldown" edits <span className="font-mono">delayBeforeUse</span>. The engine's visual fire-rate cooldown is controlled separately by <span className="font-mono">showCDOverlay</span> and uses <span className="font-mono">fireRate</span> for its timing.</div>
							</section>
						)}

						{activeTab === 'projectileTypes' && (
							<section className="mb-7">
								<h3 className="text-sm font-medium text-[#c5ccd3] mb-2">Projectile details</h3>
								<div>
									<label className="block text-xs text-[#8291a1] mb-1">Lifespan (ms)</label>
									<input type="number" min="0" value={draft.lifeSpan ?? ''} onChange={(e)=>updateDraftField('lifeSpan', e.target.value === '' ? null : Math.max(0, Number(e.target.value)||0))} className="w-40 bg-[#323d48] border border-[#3d4a57] rounded px-2 py-1 text-sm" />
								</div>
							</section>
						)}


						{activeTab === 'projectileTypes' && (
							<section className="mb-7">
								<h3 className="text-sm font-medium text-[#c5ccd3] mb-2">Sounds</h3>
								<p className="text-[11px] text-[#637588] mb-3">Assign sounds from the global Sounds tab. Projectile create/destroy sounds are stored in <span className="font-mono">effects.create.sound</span> and <span className="font-mono">effects.destroy.sound</span>.</p>
								{[['create','Create'],['destroy','Destroy']].map(([eventName,label]) => {
									const selectedSounds = draft.effects?.[eventName]?.sound || {};
									const selectedKeys = Object.keys(selectedSounds);
									return (
										<div key={eventName} className="mb-3 p-2.5 bg-[#323d48] border border-[#3d4a57] rounded-md">
											<div className="text-xs text-[#a3adb8] mb-2">{label}</div>
											{selectedKeys.length > 0 && <div className="flex flex-wrap gap-1.5 mb-2">{selectedKeys.map((soundKey) => <div key={soundKey} className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[#262e36] border border-[#3d4a57] text-xs"><span className="truncate max-w-[15rem]">{selectedSounds[soundKey]?.name || soundTypes[soundKey]?.name || soundKey}</span><button onClick={() => removeEntityEffectSound(eventName, soundKey)} className="text-[#8291a1] hover:text-red-400"><X size={12} /></button></div>)}</div>}
											<select defaultValue="" onChange={(e) => { const key=e.target.value; if(key) updateEntityEffectSound(eventName,key,true); e.target.value=''; }} className="w-full bg-[#262e36] border border-dashed border-[#48596a] rounded px-2 py-1.5 text-xs"><option value="" disabled>+ Add a sound...</option>{Object.entries(soundTypes).sort((a,b)=>(a[1]?.name||'').localeCompare(b[1]?.name||'')).filter(([key])=>!selectedKeys.includes(key)).map(([key,sound])=><option key={key} value={key}>{sound?.name || key}</option>)}</select>
										</div>
									);
								})}
							</section>
						)}

						{/* Entity scripts */}
		<section className="mb-7">
			<div className="flex items-center justify-between mb-2">
				<h3 className="text-sm font-medium text-[#c5ccd3]">Scripts</h3>
				{selectedEntityScriptKey && draft?.scripts?.[selectedEntityScriptKey] && <div className="flex rounded-md border border-[#3d4a57] overflow-hidden text-xs">
					<button onClick={() => setEntityScriptViewMode('tree')} className={`px-2.5 py-1 ${entityScriptViewMode === 'tree' ? 'bg-[#1a56da] text-[#262e36]' : 'text-[#a3adb8] hover:bg-[#323d48]'}`}>Tree view</button>
					<button onClick={() => setEntityScriptViewMode('raw')} className={`px-2.5 py-1 ${entityScriptViewMode === 'raw' ? 'bg-[#1a56da] text-[#262e36]' : 'text-[#a3adb8] hover:bg-[#323d48]'}`}>Raw JSON</button>
				</div>}
			</div>
			{getEntityScriptEntries().length === 0 ? (
				<p className="text-xs text-[#637588]">This {activeTabDef?.label?.toLowerCase() || 'entity'} has no embedded scripts.</p>
			) : (
				<div className="space-y-2">
					<select value={selectedEntityScriptKey} onChange={(e)=>selectEntityScript(e.target.value)} className="w-full bg-[#323d48] border border-[#3d4a57] rounded-md px-2 py-1.5 text-sm">
						<option value="">Choose a script...</option>
						{getEntityScriptEntries().map(([id,script])=><option key={id} value={id}>{script.name || id}</option>)}
					</select>
					{selectedEntityScriptKey && draft.scripts?.[selectedEntityScriptKey] && (() => {
						const script = draft.scripts[selectedEntityScriptKey];
						const raw = script._editorBodyText ?? JSON.stringify((({ _editorBodyText, ...body }) => body)(script), null, 2);
						let parsed = null; let parseError = null;
						try { parsed = raw.trim() ? JSON.parse(raw) : { triggers: [], conditions: [], actions: [] }; } catch (e) { parseError = e.message; }
						return <div className="bg-[#323d48] border border-[#3d4a57] rounded-md p-2.5">
							<div className="flex items-center justify-between gap-2 mb-2"><div className="text-xs text-[#8291a1]">{script.name || selectedEntityScriptKey}</div>{entityScriptViewMode === 'tree' && <span className="text-[10px] text-[#637588]">Editable tree</span>}</div>
							{entityScriptViewMode === 'tree' ? (
								parseError ? <div className="text-xs text-red-400 bg-red-950/20 border border-red-900 rounded-md p-3">Can't show the tree view - this script's JSON doesn't currently parse: {parseError}. Switch to Raw JSON to fix it.</div> :
								<ScriptTreeView script={parsed} gameData={gameData} onJumpToScript={(id) => { if (id && scriptsCollection[id]) selectScript(id); }} onOp={(path, operation, payload) => { const next = applyScriptOp(parsed, path, operation, payload); updateEntityScriptBody(selectedEntityScriptKey, JSON.stringify(next, null, 2)); }} 
										onAddAction={(listPath, index, action) => { const next = applyScriptOp(parsed, listPath, 'insert', { index, value: action }); updateEntityScriptBody(selectedEntityScriptKey, JSON.stringify(next, null, 2)); }}
										onAddCondition={(listPath, index) => { const next = applyScriptOp(parsed, listPath, 'insert', { index, value: defaultActionForType('condition') }); updateEntityScriptBody(selectedEntityScriptKey, JSON.stringify(next, null, 2)); }}
										onAddTrigger={(trigger) => { const next = deepClone(parsed); if (!Array.isArray(next.triggers)) next.triggers = []; next.triggers.push(trigger); updateEntityScriptBody(selectedEntityScriptKey, JSON.stringify(next, null, 2)); }}
									/>
							) : <>
								<textarea value={raw} onChange={(e)=>updateEntityScriptBody(selectedEntityScriptKey,e.target.value)} spellCheck={false} rows={18} className="w-full bg-[#262e36] border border-[#3d4a57] rounded p-3 text-xs font-mono text-[#c5ccd3] focus:outline-none focus:border-[#1a56da]" />
								<button onClick={()=>saveEntityScriptBody(selectedEntityScriptKey)} className="mt-2 flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[#3d4a57] text-sm hover:bg-[#48596a]"><Save size={13}/> Apply script JSON</button>
							</>}
						</div>;
					})()}
				</div>
			)}
		</section>
		
		{/* Variables */}
										<section className="mb-7">
											<h3 className="text-sm font-medium text-[#c5ccd3] mb-2">Variables</h3>
											<div className="space-y-2">
												{Object.entries(draft.variables).map(([varName, v]) => (
													<div key={varName} className="flex items-center gap-2 bg-[#323d48] border border-[#3d4a57] rounded-md px-3 py-2">
														<span className="text-sm flex-1 truncate font-mono">{varName}</span>
														<select
															value={v.dataType || 'string'}
															onChange={(e) => updateVariableField(varName, 'dataType', e.target.value)}
															className="bg-[#262e36] border border-[#3d4a57] rounded px-1.5 py-0.5 text-xs"
														>
															<option value="string">string</option>
															<option value="number">number</option>
															<option value="boolean">boolean</option>
															<option value="unit">unit</option>
															<option value="item">item</option>
														</select>
														<input
															value={v.default ?? ''}
															onChange={(e) => updateVariableField(varName, 'default', e.target.value)}
															placeholder="default value"
															className="w-28 bg-[#262e36] border border-[#3d4a57] rounded px-1.5 py-0.5 text-sm"
														/>
														<button onClick={() => removeVariable(varName)} className="text-[#637588] hover:text-red-400 ml-1">
															<X size={14} />
														</button>
													</div>
												))}
											</div>
											<button
												onClick={addVariable}
												className="mt-2 flex items-center gap-1.5 text-sm text-[#a3adb8] hover:text-[#1a56da] transition-colors"
											>
												<Plus size={13} /> Add variable
											</button>
										</section>

										{/* Sprite sheet slicer */}
										<section className="mb-7">
											<h3 className="text-sm font-medium text-[#c5ccd3] mb-2">Sprite sheet</h3>
											<input
												value={draft.cellSheet.url || ''}
												onChange={(e) => updateCellSheetField('url', e.target.value)}
												placeholder="Image URL"
												className="w-full bg-[#323d48] border border-[#3d4a57] rounded-md px-2.5 py-1.5 text-sm mb-2 focus:outline-none focus:border-[#1a56da]"
											/>
											<div className="flex gap-4 mb-3">
												<div>
													<label className="block text-xs text-[#8291a1] mb-1">Columns</label>
													<input
														type="number"
														min="1"
														value={draft.cellSheet.columnCount || 1}
														onChange={(e) => updateCellSheetField('columnCount', Number(e.target.value))}
														className="w-20 bg-[#323d48] border border-[#3d4a57] rounded px-2 py-1 text-sm"
													/>
												</div>
												<div>
													<label className="block text-xs text-[#8291a1] mb-1">Rows</label>
													<input
														type="number"
														min="1"
														value={draft.cellSheet.rowCount || 1}
														onChange={(e) => updateCellSheetField('rowCount', Number(e.target.value))}
														className="w-20 bg-[#323d48] border border-[#3d4a57] rounded px-2 py-1 text-sm"
													/>
												</div>
											</div>
											{draft.cellSheet.url ? (
												<div className="relative inline-block border border-[#48596a] rounded-md overflow-hidden max-w-full">
													<img
														src={resolveAssetUrl(draft.cellSheet.url)}
														alt="sprite sheet preview"
														className="block max-w-full"
														onLoad={(e) => setSpriteNatural({ w: e.target.naturalWidth, h: e.target.naturalHeight })}
														onError={(e) => {
															e.target.style.display = 'none';
															setSpriteNatural(null);
														}}
													/>
													<div
														className="absolute inset-0 grid pointer-events-none"
														style={{
															gridTemplateColumns: `repeat(${gridPreview.cols}, 1fr)`,
															gridTemplateRows: `repeat(${gridPreview.rows}, 1fr)`,
														}}
													>
														{Array.from({ length: gridPreview.cols * gridPreview.rows }).map((_, i) => (
															<div key={i} className="border border-[#1a56da]/60" />
														))}
													</div>
												</div>
											) : (
												<p className="text-xs text-[#637588]">Add an image URL to preview the grid slicing.</p>
											)}
											{draft.cellSheet.url && !assetBaseUrl && !/^https?:\/\//i.test(draft.cellSheet.url) && (
												<p className="text-xs text-[#1a56da]/80 mt-1.5">
													This is a relative path ({draft.cellSheet.url}) - set the "Asset base URL" at the top of the
													page (your game server's address) so previews can actually load it.
												</p>
											)}
											<p className="text-xs text-[#637588] mt-2">
												Columns/rows should match how many distinct frames are actually laid out in the image - a
												mismatch here is what causes animations to silently freeze on one frame in-game.
											</p>
										</section>

										{/* Body / size */}
										<section className="mb-7">
											<h3 className="text-sm font-medium text-[#c5ccd3] mb-2">Body &amp; size</h3>
											<div className="flex flex-wrap items-center gap-1.5 mb-3">
												{Object.keys(draft.bodies).map((bodyName) => (
													<span
														key={bodyName}
														onClick={() => setSelectedBodyName(bodyName)}
														className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs cursor-pointer border ${
															selectedBodyName === bodyName
																? 'bg-[#1a56da] border-[#1a56da] text-[#262e36] font-medium'
																: 'bg-[#323d48] border-[#48596a] text-[#c5ccd3] hover:border-[#8291a1]'
														}`}
													>
														{bodyName}
														<button
															onClick={(e) => {
																e.stopPropagation();
																removeBody(bodyName);
															}}
															className={selectedBodyName === bodyName ? 'text-[#323d48]/60 hover:text-[#323d48]' : 'text-[#637588] hover:text-red-400'}
														>
															<X size={11} />
														</button>
													</span>
												))}
												<button
													onClick={addBody}
													className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs border border-dashed border-[#48596a] text-[#8291a1] hover:border-[#1a56da] hover:text-[#1a56da] transition-colors"
												>
													<Plus size={11} /> body
												</button>
											</div>

											{draft.bodies[selectedBodyName] && (
												<div className="flex gap-6 items-start">
													<div>
														<div className="flex gap-3 mb-3">
															<div>
																<label className="block text-xs text-[#8291a1] mb-1">Width</label>
																<input
																	type="number"
																	min="1"
																	value={draft.bodies[selectedBodyName].width ?? TILE_PX}
																	onChange={(e) => updateBodySize('width', e.target.value)}
																	className="w-24 bg-[#323d48] border border-[#3d4a57] rounded px-2 py-1 text-sm"
																/>
															</div>
															<div>
																<label className="block text-xs text-[#8291a1] mb-1">Height</label>
																<input
																	type="number"
																	min="1"
																	value={draft.bodies[selectedBodyName].height ?? TILE_PX}
																	onChange={(e) => updateBodySize('height', e.target.value)}
																	className="w-24 bg-[#323d48] border border-[#3d4a57] rounded px-2 py-1 text-sm"
																/>
															</div>
														</div>
														<p className="text-xs text-[#637588] max-w-[15rem]">
															1 tile = {TILE_PX}×{TILE_PX}px. Other physics settings for this body (type, gravity,
															rotation, etc.) are still editable in Advanced below.
														</p>
													</div>

													{(() => {
														const body = draft.bodies[selectedBodyName];
														const bw = body.width || TILE_PX;
														const bh = body.height || TILE_PX;
														const scale = 0.5;
														const tileCss = TILE_PX * scale;
														const bodyCssW = bw * scale;
														const bodyCssH = bh * scale;

														const cols = draft.cellSheet.columnCount || 1;
														const rows = draft.cellSheet.rowCount || 1;
														const hasSprite = !!draft.cellSheet.url;

										// don't know why it keeps doing this
										const containerW = Math.max(tileCss * 2, bodyCssW + tileCss);
														const containerH = Math.max(tileCss * 2, bodyCssH + tileCss);

														return (
															<div className="shrink-0">
																<div
																	className="relative border border-[#48596a] rounded-md overflow-hidden bg-[#323d48]"
																	style={{
																		width: containerW,
																		height: containerH,
																		backgroundImage:
																			'linear-gradient(to right, rgba(255,255,255,0.12) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.12) 1px, transparent 1px)',
																		backgroundSize: `${tileCss}px ${tileCss}px`,
																	}}
																>
																	{hasSprite && (
														<div
															className="absolute overflow-hidden"
															style={{
																width: bodyCssW,
																height: bodyCssH,
																left: '50%',
																top: '50%',
																transform: 'translate(-50%, -50%)',
																imageRendering: 'pixelated',
															}}
															>
															<img
																src={resolveAssetUrl(draft.cellSheet.url)}
																alt="body preview"
																draggable={false}
																style={{
																	display: 'block',
																	width: `${bodyCssW * cols}px`,
																	height: `${bodyCssH * rows}px`,
																	maxWidth: 'none',
																	maxHeight: 'none',
																	imageRendering: 'pixelated',
																}}
															/>
															</div>
													)}
													
																		<div

																		className={`absolute border flex items-center justify-center ${
																			hasSprite ? 'border-emerald-400' : 'bg-emerald-500/40 border-emerald-400'
																		}`}
																		style={{
																			width: bodyCssW,
																			height: bodyCssH,
																			left: '50%',
																			top: '50%',
																			transform: 'translate(-50%, -50%)',
																		}}
																	>
																		{!hasSprite && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
																	</div>
																</div>
																<p className="text-xs text-[#637588] mt-1.5 text-center">
																	{(bw / TILE_PX).toFixed(2)} × {(bh / TILE_PX).toFixed(2)} tiles
																</p>
															</div>
														);
													})()}
												</div>
											)}
										</section>


										{/* Advanced raw JSON */}
										<details className="mb-4">
											<summary className="text-sm font-medium text-[#c5ccd3] cursor-pointer select-none">
												Advanced (AI behavior, abilities, states, everything else)
											</summary>
											<textarea
												value={advancedText}
												onChange={(e) => setAdvancedText(e.target.value)}
												spellCheck={false}
												rows={14}
												className="w-full mt-2 bg-[#323d48] border border-[#3d4a57] rounded-md p-3 text-xs font-mono text-[#c5ccd3] focus:outline-none focus:border-[#1a56da]"
											/>
											{advancedError && <p className="text-xs text-red-400 mt-1">{advancedError}</p>}
										</details>
									</div>
								)}
							</div>
						</>
					) : isGroupTab ? (
						<>
							{/* List pane */}
							<div className="w-64 shrink-0 border-r border-[#3d4a57] flex flex-col">
								<div className="p-3 border-b border-[#3d4a57]">
									<div className="relative">
										<Search size={13} className="absolute left-2.5 top-2.5 text-[#637588]" />
										<input
											value={search}
											onChange={(e) => setSearch(e.target.value)}
											placeholder="Search..."
											className="w-full bg-[#323d48] border border-[#48596a] rounded-md pl-8 pr-2 py-1.5 text-sm placeholder-[#637588] focus:outline-none focus:border-[#1a56da]"
										/>
									</div>
									<button
										onClick={startNewGroup}
										className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 mt-2 rounded-md border border-dashed border-[#48596a] text-sm text-[#a3adb8] hover:border-[#1a56da] hover:text-[#1a56da] transition-colors"
									>
										<Plus size={14} /> New group
									</button>
								</div>
								<div className="flex-1 overflow-y-auto">
									{groupVariableEntries.map(([key, v]) => (
										<button
											key={key}
											onClick={() => selectGroup(key)}
											className={`w-full text-left px-3 py-2 border-b border-[#323d48] transition-colors ${
												selectedKey === key ? 'bg-[#323d48]' : 'hover:bg-[#323d48]/50'
											}`}
										>
											<div className="text-sm text-[#e1e6ea] truncate">{key}</div>
											<div className="text-xs text-[#637588]">{Object.keys(v?.default || {}).length} members</div>
										</button>
									))}
									{groupVariableEntries.length === 0 && (
										<div className="text-sm text-[#637588] text-center py-8 px-4">Nothing here yet.</div>
									)}
								</div>
							</div>

							{/* Editor pane */}
							<div className="flex-1 overflow-y-auto p-6">
								{!groupDraft ? (
									<div className="text-[#637588] text-sm mt-16 text-center">
										Select a group on the left, or create a new one.
									</div>
								) : (
									<div className="max-w-2xl">
										<div className="flex items-center justify-between mb-4">
											<div className="flex-1">
												<label className="block text-xs text-[#8291a1] mb-1">Key</label>
												<input
													value={groupDraft.key}
													onChange={(e) => setGroupDraft((d) => ({ ...d, key: e.target.value }))}
													className="text-lg font-semibold bg-transparent border-b border-transparent hover:border-[#48596a] focus:border-[#1a56da] focus:outline-none px-0.5 w-full"
												/>
												{groupDraft.isNew && <span className="text-xs text-[#1a56da]">(new, not saved yet)</span>}
											</div>
											<div className="flex gap-2 ml-4">
												{!groupDraft.isNew && (
													<button
														onClick={deleteGroup}
														className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-red-900 text-red-400 text-sm hover:bg-red-950/40 transition-colors"
													>
														<Trash2 size={13} /> Delete
													</button>
												)}
												<button
													onClick={saveGroupDraft}
													className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[#1a56da] text-[#262e36] text-sm font-medium hover:bg-[#1a56da] transition-colors"
												>
													<Save size={13} /> Save to working copy
												</button>
											</div>
										</div>

										<p className="text-xs text-[#637588] mb-4">
											DataType: <span className="font-mono text-[#a3adb8]">{activeGroupDef.dataType}</span> - renaming this
											group won't update any scripts that already reference it by name.
										</p>

										{savedMsg && (
											<div className="mb-5 text-sm text-emerald-400 bg-emerald-950/30 border border-emerald-900 rounded-md px-3 py-2">
												{savedMsg}
											</div>
										)}

										<h3 className="text-sm font-medium text-[#c5ccd3] mb-2">
											{activeGroupDef.collection === 'unitTypes' ? 'Units' : 'Items'} in this group
										</h3>
										<div className="space-y-2">
											{Object.entries(groupDraft.entries).map(([id, entry]) => (
												<div key={id} className="flex items-center gap-2 bg-[#323d48] border border-[#3d4a57] rounded-md px-3 py-2">
													<span className="text-sm flex-1 truncate">{groupMemberCollection[id]?.name || id}</span>
													<label className="text-xs text-[#8291a1]">probability</label>
													<input
														type="number"
														value={entry.probability ?? 0}
														onChange={(e) => updateGroupMemberField(id, 'probability', Number(e.target.value))}
														className="w-16 bg-[#262e36] border border-[#3d4a57] rounded px-1.5 py-0.5 text-sm"
													/>
													<label className="text-xs text-[#8291a1]">quantity</label>
													<input
														type="number"
														value={entry.quantity ?? 1}
														onChange={(e) => updateGroupMemberField(id, 'quantity', Number(e.target.value))}
														className="w-16 bg-[#262e36] border border-[#3d4a57] rounded px-1.5 py-0.5 text-sm"
													/>
													<button onClick={() => removeGroupMember(id)} className="text-[#637588] hover:text-red-400 ml-1">
														<X size={14} />
													</button>
												</div>
											))}
										</div>
										<select
											onChange={(e) => {
												addGroupMember(e.target.value);
												e.target.value = '';
											}}
											defaultValue=""
											className="mt-2 bg-[#323d48] border border-dashed border-[#48596a] rounded-md px-2 py-1.5 text-sm text-[#a3adb8] w-full focus:outline-none focus:border-[#1a56da]"
										>
											<option value="" disabled>
												+ Add {activeGroupDef.collection === 'unitTypes' ? 'a unit' : 'an item'}...
											</option>
											{Object.entries(groupMemberCollection)
												.filter(([id]) => !groupDraft.entries[id])
												.sort((a, b) => (a[1]?.name || '').localeCompare(b[1]?.name || ''))
												.map(([id, v]) => (
													<option key={id} value={id}>
														{v?.name || id}
													</option>
												))}
										</select>
									</div>
								)}
							</div>
						</>
					) : isScriptsTab ? (
						<>
							{/* List pane */}
							<div className="w-64 shrink-0 border-r border-[#3d4a57] flex flex-col">
								<div className="p-3 border-b border-[#3d4a57]">
									<div className="relative">
										<Search size={13} className="absolute left-2.5 top-2.5 text-[#637588]" />
										<input
											value={search}
											onChange={(e) => setSearch(e.target.value)}
											placeholder="Search..."
											className="w-full bg-[#323d48] border border-[#48596a] rounded-md pl-8 pr-2 py-1.5 text-sm placeholder-[#637588] focus:outline-none focus:border-[#1a56da]"
										/>
									</div>
									<div className="flex gap-1.5 mt-2">
										<button
											onClick={() => startNewScript(selectedScriptFolderId)}
											className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md border border-dashed border-[#48596a] text-sm text-[#a3adb8] hover:border-[#1a56da] hover:text-[#1a56da] transition-colors"
										>
											<Plus size={14} /> New script
										</button>
										<button
											title="New group"
											onClick={() => addScriptFolder(selectedScriptFolderId)}
											className="flex items-center justify-center px-2.5 py-1.5 rounded-md border border-dashed border-[#48596a] text-[#a3adb8] hover:border-[#1a56da] hover:text-[#1a56da] transition-colors"
										>
											<FolderPlus size={14} />
										</button>
									</div>
									{selectedScriptFolderId && !search.trim() && (
										<div className="text-xs text-[#637588] mt-1.5 truncate">
											New scripts go into:{' '}
											<span className="text-[#a3adb8]">{scriptsCollection[selectedScriptFolderId]?.folderName || 'top level'}</span>
										</div>
									)}
								</div>
								<div className="flex-1 overflow-y-auto">
									{search.trim() ? (
										<>
											{scriptSearchResults.map(([key, s]) => (
												<button
													key={key}
													onClick={() => selectScript(key)}
													className={`w-full text-left px-3 py-2 border-b border-[#323d48] transition-colors ${
														selectedKey === key ? 'bg-[#323d48]' : 'hover:bg-[#323d48]/50'
													}`}
												>
													<div className="text-sm text-[#e1e6ea] truncate">{s.name || '(unnamed)'}</div>
													<div className="text-xs text-[#637588] truncate">
														{(s.triggers || []).map((t) => t.type).join(', ') || 'no triggers'}
													</div>
												</button>
											))}
											{scriptSearchResults.length === 0 && (
												<div className="text-sm text-[#637588] text-center py-8 px-4">No matches.</div>
											)}
										</>
									) : (
										<>
											{scriptTree.map((node) =>
												node.kind === 'folder' ? (
													<ScriptFolderRow key={node.id} node={node} depth={0} />
												) : (
													<button
														key={node.id}
														onClick={() => selectScript(node.id)}
														className={`w-full text-left px-3 py-2 border-b border-[#323d48] transition-colors ${
															selectedKey === node.id ? 'bg-[#323d48]' : 'hover:bg-[#323d48]/50'
														}`}
													>
														<div className="text-sm text-[#e1e6ea] truncate">{scriptsCollection[node.id]?.name || '(unnamed)'}</div>
														<div className="text-xs text-[#637588] truncate">
															{(scriptsCollection[node.id]?.triggers || []).map((t) => t.type).join(', ') || 'no triggers'}
														</div>
													</button>
												)
											)}
											{scriptTree.length === 0 && (
												<div className="text-sm text-[#637588] text-center py-8 px-4">Nothing here yet.</div>
											)}
										</>
									)}
								</div>
							</div>

							{/* Editor pane */}
							<div className="flex-1 overflow-y-auto p-6">
								{!scriptDraft ? (
									<div className="text-[#637588] text-sm mt-16 text-center">
										Select a script on the left, or create a new one.
									</div>
								) : (
									<div className="max-w-2xl">
										<div className="flex items-center justify-between mb-4">
											<div className="flex-1">
												<input
													value={scriptDraft.name}
													onChange={(e) => setScriptDraft((d) => ({ ...d, name: e.target.value }))}
													className="text-xl font-semibold bg-transparent border-b border-transparent hover:border-[#48596a] focus:border-[#1a56da] focus:outline-none px-0.5 w-full"
												/>
												<div className="text-xs text-[#637588] font-mono mt-1">
													{scriptDraft.key} {scriptDraft.isNew && <span className="text-[#1a56da] ml-1">(new, not saved yet)</span>}
												</div>
											</div>
											<div className="flex gap-2 ml-4">
												{!scriptDraft.isNew && (
													<button
														onClick={deleteScript}
														className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-red-900 text-red-400 text-sm hover:bg-red-950/40 transition-colors"
													>
														<Trash2 size={13} /> Delete
													</button>
												)}
												<button
													onClick={saveScriptDraft}
													className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[#1a56da] text-[#262e36] text-sm font-medium hover:bg-[#1a56da] transition-colors"
												>
													<Save size={13} /> Save to working copy
												</button>
											</div>
										</div>

										<div className="mb-6 flex items-center gap-2">
											<span className="text-xs text-[#8291a1] shrink-0">Group</span>
											<select
												value={scriptDraft.parentId ?? '__top__'}
												onChange={(e) =>
													setScriptDraft((d) => ({ ...d, parentId: e.target.value === '__top__' ? null : e.target.value }))
												}
												className="bg-[#323d48] border border-[#3d4a57] rounded-md px-2 py-1 text-sm focus:outline-none focus:border-[#1a56da]"
											>
												{scriptFolderOptions.map((f) => (
													<option key={f.id ?? '__top__'} value={f.id ?? '__top__'}>
														{'—'.repeat(f.depth)} {f.name}
													</option>
												))}
											</select>
										</div>

										{savedMsg && (
											<div className="mb-5 text-sm text-emerald-400 bg-emerald-950/30 border border-emerald-900 rounded-md px-3 py-2">
												{savedMsg}
											</div>
										)}

										<div className="flex items-center justify-between mb-2">
											<h3 className="text-sm font-medium text-[#c5ccd3]">Triggers, conditions &amp; actions</h3>
											<div className="flex rounded-md border border-[#3d4a57] overflow-hidden text-xs">
												<button
													onClick={() => setScriptViewMode('tree')}
													className={`px-2.5 py-1 ${scriptViewMode === 'tree' ? 'bg-[#1a56da] text-[#262e36]' : 'text-[#a3adb8] hover:bg-[#323d48]'}`}
												>
													Tree view
												</button>
												<button
													onClick={() => setScriptViewMode('raw')}
													className={`px-2.5 py-1 ${scriptViewMode === 'raw' ? 'bg-[#1a56da] text-[#262e36]' : 'text-[#a3adb8] hover:bg-[#323d48]'}`}
												>
													Raw JSON
												</button>
											</div>
										</div>
										{scriptViewMode === 'tree' ? (
											scriptDraftParsed.error ? (
												<div className="text-xs text-red-400 bg-red-950/20 border border-red-900 rounded-md p-3">
													Can't show the tree view - this script's JSON doesn't currently parse: {scriptDraftParsed.error}.
													Switch to Raw JSON to fix it.
												</div>
											) : (
												<div className="bg-[#323d48] border border-[#3d4a57] rounded-md p-3 overflow-x-auto">
													<ScriptTreeView
														script={scriptDraftParsed.value}
														gameData={gameData}
														onJumpToScript={(id) => {
															if (id && scriptsCollection[id]) selectScript(id);
														}}
														onOp={(path, operation, payload) => {
															const next = applyScriptOp(scriptDraftParsed.value, path, operation, payload);
															setScriptDraft((d) => ({ ...d, bodyText: JSON.stringify(next, null, 2) }));
														}}
													
										onAddAction={addScriptAction}
										onAddCondition={addScriptCondition}
										onAddTrigger={addScriptTrigger}
									/>
												</div>
											)
										) : (
											<>
												<textarea
													value={scriptDraft.bodyText}
													onChange={(e) => setScriptDraft((d) => ({ ...d, bodyText: e.target.value }))}
													spellCheck={false}
													rows={22}
													className="w-full bg-[#323d48] border border-[#3d4a57] rounded-md p-3 text-xs font-mono text-[#c5ccd3] focus:outline-none focus:border-[#1a56da]"
												/>
												{scriptBodyError && <p className="text-xs text-red-400 mt-1">{scriptBodyError}</p>}
											</>
										)}
										<p className="text-xs text-[#637588] mt-2">
											Use the add buttons to create triggers, actions, and condition nodes. Existing rows can be edited,
											duplicated, reordered, disabled, or deleted; Raw JSON remains available for unusual data.
										</p>
									</div>
								)}
							</div>
						</>
					) : isDialoguesTab ? (
						<>
							{/* List pane */}
							<div className="w-64 shrink-0 border-r border-[#3d4a57] flex flex-col">
								<div className="p-3 border-b border-[#3d4a57]">
									<div className="relative">
										<Search size={13} className="absolute left-2.5 top-2.5 text-[#637588]" />
										<input
											value={search}
											onChange={(e) => setSearch(e.target.value)}
											placeholder="Search..."
											className="w-full bg-[#323d48] border border-[#48596a] rounded-md pl-8 pr-2 py-1.5 text-sm placeholder-[#637588] focus:outline-none focus:border-[#1a56da]"
										/>
									</div>
									<button
										onClick={startNewDialogue}
										className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 mt-2 rounded-md border border-dashed border-[#48596a] text-sm text-[#a3adb8] hover:border-[#1a56da] hover:text-[#1a56da] transition-colors"
									>
										<Plus size={14} /> New dialogue
									</button>
								</div>
								<div className="flex-1 overflow-y-auto">
									{dialogueEntries.map(([key, d]) => (
										<button
											key={key}
											onClick={() => selectDialogue(key)}
											className={`w-full text-left px-3 py-2 border-b border-[#323d48] transition-colors ${
												selectedKey === key ? 'bg-[#323d48]' : 'hover:bg-[#323d48]/50'
											}`}
										>
											<div className="text-sm text-[#e1e6ea] truncate">{d?.name || '(unnamed)'}</div>
											<div className="text-xs text-[#637588] truncate">{(d?.options || []).length} option(s)</div>
										</button>
									))}
									{dialogueEntries.length === 0 && (
										<div className="text-sm text-[#637588] text-center py-8 px-4">Nothing here yet.</div>
									)}
								</div>
							</div>

							{/* Editor pane */}
							<div className="flex-1 overflow-y-auto p-6">
								{!dialogueDraft ? (
									<div className="text-[#637588] text-sm mt-16 text-center">
										Select a dialogue on the left, or create a new one.
									</div>
								) : (
									<div className="max-w-2xl">
										<div className="flex items-center justify-between mb-4">
											<div className="flex-1">
												<label className="block text-xs text-[#8291a1] mb-1">Name (editor label only)</label>
												<input
													value={dialogueDraft.name}
													onChange={(e) => updateDialogueField('name', e.target.value)}
													className="text-lg font-semibold bg-transparent border-b border-transparent hover:border-[#48596a] focus:border-[#1a56da] focus:outline-none px-0.5 w-full"
												/>
												<div className="text-xs text-[#637588] font-mono mt-1">
													{dialogueDraft.key}{' '}
													{dialogueDraft.isNew && <span className="text-[#1a56da] ml-1">(new, not saved yet)</span>}
												</div>
											</div>
											<div className="flex gap-2 ml-4">
												{!dialogueDraft.isNew && (
													<button
														onClick={deleteDialogue}
														className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-red-900 text-red-400 text-sm hover:bg-red-950/40 transition-colors"
													>
														<Trash2 size={13} /> Delete
													</button>
												)}
												<button
													onClick={saveDialogueDraft}
													className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[#1a56da] text-[#262e36] text-sm font-medium hover:bg-[#1a56da] transition-colors"
												>
													<Save size={13} /> Save to working copy
												</button>
											</div>
										</div>

										{savedMsg && (
											<div className="mb-5 text-sm text-emerald-400 bg-emerald-950/30 border border-emerald-900 rounded-md px-3 py-2">
												{savedMsg}
											</div>
										)}

										<div className="mb-4">
											<label className="block text-xs text-[#8291a1] mb-1">Dialogue title (shown to players)</label>
											<input
												value={dialogueDraft.dialogueTitle}
												onChange={(e) => updateDialogueField('dialogueTitle', e.target.value)}
												className="w-full bg-[#323d48] border border-[#3d4a57] rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:border-[#1a56da]"
											/>
										</div>

										<div className="mb-4">
											<label className="block text-xs text-[#8291a1] mb-1">Message</label>
											<textarea
												value={dialogueDraft.message}
												onChange={(e) => updateDialogueField('message', e.target.value)}
												rows={4}
												className="w-full bg-[#323d48] border border-[#3d4a57] rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:border-[#1a56da]"
											/>
											<p className="text-xs text-[#637588] mt-1">Supports basic HTML like {'<br>'} for line breaks.</p>
										</div>

										<div className="flex gap-4 mb-6">
											<div className="flex-1">
												<label className="block text-xs text-[#8291a1] mb-1">Image URL (optional)</label>
												<input
													value={dialogueDraft.image}
													onChange={(e) => updateDialogueField('image', e.target.value)}
													className="w-full bg-[#323d48] border border-[#3d4a57] rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:border-[#1a56da]"
												/>
											</div>
											<div>
												<label className="block text-xs text-[#8291a1] mb-1">Letter print speed</label>
												<input
													type="number"
													min="0"
													value={dialogueDraft.letterPrintSpeed}
													onChange={(e) => updateDialogueField('letterPrintSpeed', e.target.value)}
													className="w-28 bg-[#323d48] border border-[#3d4a57] rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:border-[#1a56da]"
												/>
												<p className="text-xs text-[#637588] mt-1">0 = instant</p>
											</div>
											{dialogueDraft.image && (
												<img
													src={resolveAssetUrl(dialogueDraft.image)}
													alt="dialogue"
													className="w-14 h-14 object-cover rounded-md border border-[#48596a]"
													onError={(e) => {
														e.target.style.display = 'none';
													}}
												/>
											)}
										</div>

										<h3 className="text-sm font-medium text-[#c5ccd3] mb-2">Options</h3>
										<div className="space-y-2">
											{dialogueDraft.options.map((opt, i) => (
												<div key={i} className="bg-[#323d48] border border-[#3d4a57] rounded-md p-2.5">
													<div className="flex items-center gap-2 mb-2">
														<input
															value={opt.name}
															onChange={(e) => updateDialogueOption(i, 'name', e.target.value)}
															placeholder="Button label"
															className="flex-1 bg-[#262e36] border border-[#3d4a57] rounded px-2 py-1 text-sm"
														/>
														<button
															onClick={() => moveDialogueOption(i, -1)}
															disabled={i === 0}
															className="text-[#8291a1] hover:text-[#1a56da] disabled:opacity-30 disabled:hover:text-[#8291a1]"
														>
															<ChevronRight size={13} className="-rotate-90" />
														</button>
														<button
															onClick={() => moveDialogueOption(i, 1)}
															disabled={i === dialogueDraft.options.length - 1}
															className="text-[#8291a1] hover:text-[#1a56da] disabled:opacity-30 disabled:hover:text-[#8291a1]"
														>
															<ChevronRight size={13} className="rotate-90" />
														</button>
														<button onClick={() => removeDialogueOption(i)} className="text-[#637588] hover:text-red-400">
															<X size={14} />
														</button>
													</div>
													<div className="flex gap-2">
														<div className="flex-1">
															<label className="block text-xs text-[#8291a1] mb-1">On click, run script</label>
															<select
																value={opt.scriptName || ''}
																onChange={(e) => updateDialogueOption(i, 'scriptName', e.target.value)}
																className="w-full bg-[#262e36] border border-[#3d4a57] rounded px-1.5 py-1 text-xs"
															>
																<option value="">(none)</option>
																{pickableScripts.map(([sk, sv]) => (
																	<option key={sk} value={sk}>
																		{sv.name || sk}
																	</option>
																))}
															</select>
														</div>
														<div className="flex-1">
															<label className="block text-xs text-[#8291a1] mb-1">Then show dialogue</label>
															<select
																value={opt.followUpDialogue || ''}
																onChange={(e) => updateDialogueOption(i, 'followUpDialogue', e.target.value)}
																className="w-full bg-[#262e36] border border-[#3d4a57] rounded px-1.5 py-1 text-xs"
															>
																<option value="">(none - closes dialogue)</option>
																{Object.entries(dialoguesCollection).map(([dk, dv]) => (
																	<option key={dk} value={dk}>
																		{dv.name || dk}
																	</option>
																))}
															</select>
														</div>
													</div>
												</div>
											))}
										</div>
										<button
											onClick={addDialogueOption}
											className="mt-2 flex items-center gap-1.5 text-sm text-[#a3adb8] hover:text-[#1a56da] transition-colors"
										>
											<Plus size={13} /> Add option
										</button>
									</div>
								)}
							</div>
						</>
					) : activeTab === 'attributeTypes' ? (
						<div className="flex-1 overflow-y-auto p-6 max-w-2xl">
							<div className="flex items-center justify-between mb-4">
								<h2 className="text-base font-medium">Attribute types</h2>
								<button
									onClick={addAttributeType}
									className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-dashed border-[#48596a] text-sm text-[#a3adb8] hover:border-[#1a56da] hover:text-[#1a56da] transition-colors"
								>
									<Plus size={14} /> New attribute type
								</button>
							</div>
							<div className="space-y-2">
								{Object.entries(attributeTypes).map(([key, attr]) => (
									<div key={key} className="flex items-center gap-2 bg-[#323d48] border border-[#3d4a57] rounded-md px-3 py-2">
										<input
											value={attr.name || ''}
											onChange={(e) => updateAttributeType(key, 'name', e.target.value)}
											className="flex-1 bg-transparent text-sm focus:outline-none"
										/>
										<label className="text-xs text-[#8291a1]">default</label>
										<input
											type="number"
											value={attr.value ?? 0}
											onChange={(e) => updateAttributeType(key, 'value', Number(e.target.value))}
											className="w-16 bg-[#262e36] border border-[#3d4a57] rounded px-1.5 py-0.5 text-sm"
										/>
										<label className="text-xs text-[#8291a1]">min</label>
										<input
											type="number"
											value={attr.min ?? 0}
											onChange={(e) => updateAttributeType(key, 'min', Number(e.target.value))}
											className="w-14 bg-[#262e36] border border-[#3d4a57] rounded px-1.5 py-0.5 text-sm"
										/>
										<label className="text-xs text-[#8291a1]">max</label>
										<input
											type="number"
											value={attr.max ?? 100}
											onChange={(e) => updateAttributeType(key, 'max', Number(e.target.value))}
											className="w-16 bg-[#262e36] border border-[#3d4a57] rounded px-1.5 py-0.5 text-sm"
										/>
									</div>
								))}
							</div>
							<p className="text-xs text-[#637588] mt-4">
								These are the attribute types available to attach on any unit, item, or projectile from its editor tab.
							</p>
						</div>
					) : activeTab === 'sounds' ? (
						<div className="flex-1 overflow-y-auto p-6">
							<div className="max-w-3xl">
								<div className="flex items-center justify-between mb-4">
									<div>
										<h2 className="text-base font-medium">Global sounds</h2>
										<p className="text-xs text-[#637588] mt-1">Edit the game's global <span className="font-mono">data.sound</span> library. Changes here are available to the item sound assigner.</p>
									</div>
									<button onClick={addGlobalSound} className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[#1a56da] text-[#262e36] text-sm font-medium hover:bg-[#1a56da] transition-colors"><Plus size={14} /> New sound</button>
								</div>
								<div className="space-y-2">
									{Object.entries(soundTypes).sort((a,b)=>(a[1]?.name||'').localeCompare(b[1]?.name||'')).map(([key,sound]) => (
										<div key={key} data-sound-key={key} className="bg-[#323d48] border border-[#3d4a57] rounded-md p-3">
											<div className="flex items-center gap-2 mb-2">
												<input value={sound?.name || ''} onChange={(e)=>updateGlobalSound(key,'name',e.target.value)} placeholder="Sound name" className="flex-1 bg-[#262e36] border border-[#3d4a57] rounded px-2 py-1 text-sm" />
												<label className="text-xs text-[#637588]">volume</label>
												<input type="number" min="0" max="100" value={sound?.volume ?? 100} onChange={(e)=>updateGlobalSound(key,'volume',Math.max(0,Math.min(100,Number(e.target.value)||0)))} className="w-20 bg-[#262e36] border border-[#3d4a57] rounded px-2 py-1 text-sm" />
												<label className="text-xs text-[#637588]">pitch %</label>
												<input type="number" min="0" max="100" step="1" value={Math.round((Number(sound?.pitchRandomization ?? 0.1) || 0) * 100)} onChange={(e)=>updateGlobalSound(key,'pitchRandomization',Math.max(0,Math.min(1,Number(e.target.value)||0))/100)} className="w-20 bg-[#262e36] border border-[#3d4a57] rounded px-2 py-1 text-sm" title="Random pitch variation applied by the game. 0% keeps the sound at its original pitch." />
												<button onClick={() => previewGlobalSound(key)} disabled={!sound?.file} title={previewingSoundKey === key ? 'Stop preview' : 'Play preview'} className="text-[#a3adb8] hover:text-[#1a56da] disabled:opacity-30 disabled:cursor-not-allowed">
													{previewingSoundKey === key ? <Square size={14}/> : <Play size={14}/>}
												</button>
												<button onClick={()=>deleteGlobalSound(key)} className="text-[#8291a1] hover:text-red-400" title="Delete sound"><Trash2 size={14}/></button>
											</div>
											<input value={sound?.file || ''} onChange={(e)=>updateGlobalSound(key,'file',e.target.value)} placeholder="https://.../sound.ogg or /assets/audio/..." className="w-full bg-[#262e36] border border-[#3d4a57] rounded px-2 py-1 text-sm" />
											<div className="text-[11px] text-[#637588] mt-1.5 font-mono truncate">{key}</div>
										</div>
									))}
								</div>
								{Object.keys(soundTypes).length === 0 && <div className="text-sm text-[#637588] text-center py-8">No sounds yet.</div>}
							</div>
						</div>
					) : activeTab === 'playerTypes' ? (
						<div className="flex-1 overflow-y-auto p-6">
							<div className="max-w-3xl">
								<div className="flex items-center justify-between mb-4">
									<div>
										<h2 className="text-base font-medium">Player Types</h2>
										<p className="text-xs text-[#637588] mt-1">Teams players get assigned to - controls diplomacy, name label/chat visibility, and any attributes or variables carried on the player itself rather than their unit.</p>
									</div>
									<button onClick={addPlayerType} className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[#1a56da] text-white text-sm font-medium hover:opacity-90 transition-colors"><Plus size={14} /> Add New</button>
								</div>
								<div className="border border-[#3d4a57] rounded-md overflow-hidden">
									<div className="grid grid-cols-[1fr_100px_80px] gap-2 px-3 py-2 bg-[#323d48] text-xs uppercase tracking-wide text-[#8291a1] border-b border-[#3d4a57]">
										<div>Name</div>
										<div>Color</div>
										<div className="text-right">Action</div>
									</div>
									{Object.entries(playerTypes).map(([key, pt]) => (
										<div
											key={key}
											onClick={() => setEditingPlayerTypeKey(key)}
											className="grid grid-cols-[1fr_100px_80px] gap-2 px-3 py-2.5 border-b border-[#3d4a57] last:border-b-0 hover:bg-[#323d48]/60 cursor-pointer items-center"
										>
											<div className="text-sm truncate">{pt.name || key}</div>
											<div><div className="w-6 h-6 rounded border border-[#48596a]" style={{ background: pt.color || '#ffffff' }} /></div>
											<div className="text-right">
												<button
													onClick={(e) => { e.stopPropagation(); deletePlayerType(key); }}
													className="p-1.5 rounded-md bg-red-500/90 hover:bg-red-500 text-white"
													title="Delete"
												>
													<Trash2 size={13} />
												</button>
											</div>
										</div>
									))}
									{Object.keys(playerTypes).length === 0 && <div className="text-sm text-[#637588] text-center py-8">No player types yet.</div>}
								</div>
							</div>
						</div>
					) : (
						<div className="flex-1 overflow-y-auto p-6 max-w-2xl">
							<div className="flex items-center justify-between mb-4">
								<h2 className="text-base font-medium">Global variables</h2>
								<button
									onClick={addGlobalVariable}
									className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-dashed border-[#48596a] text-sm text-[#a3adb8] hover:border-[#1a56da] hover:text-[#1a56da] transition-colors"
								>
									<Plus size={14} /> New variable
								</button>
							</div>
							<div className="space-y-2">
								{Object.entries(gameData?.data?.variables || {}).map(([name, v]) => (
									<div key={name} className="flex items-center gap-2 bg-[#323d48] border border-[#3d4a57] rounded-md px-3 py-2">
										<span className="text-sm flex-1 font-mono">{name}</span>
										<select
											value={v.dataType || 'string'}
											onChange={(e) => updateGlobalVariable(name, 'dataType', e.target.value)}
											className="bg-[#262e36] border border-[#3d4a57] rounded px-1.5 py-0.5 text-xs"
										>
											<option value="string">string</option>
											<option value="number">number</option>
											<option value="boolean">boolean</option>
										</select>
										<input
											value={v.default ?? ''}
											onChange={(e) => updateGlobalVariable(name, 'default', e.target.value)}
											placeholder="default value"
											className="w-32 bg-[#262e36] border border-[#3d4a57] rounded px-1.5 py-0.5 text-sm"
										/>
									</div>
								))}
							</div>
							<p className="text-xs text-[#637588] mt-4">
								Game-wide variables, not tied to any specific unit/item/projectile.
							</p>
						</div>
					)}
				</div>
			)}

			{editingPlayerTypeKey && playerTypes[editingPlayerTypeKey] && (() => {
				const pt = playerTypes[editingPlayerTypeKey];
				const key = editingPlayerTypeKey;
				const usedAttrKeys = new Set(Object.keys(pt.attributes || {}));
				const unusedAttrKeys = Object.keys(attributeTypes).filter((k) => !usedAttrKeys.has(k));
				const usedVarNames = new Set(Object.keys(pt.variables || {}));
				const unusedVarNames = Object.keys(gameData?.data?.variables || {}).filter((n) => !usedVarNames.has(n));
				const otherTypeEntries = Object.entries(playerTypes).filter(([k]) => k !== key);

				function ToggleField({ label, field }) {
					const value = pt[field] !== false; // treat missing as true, matching engine default for showNameLabel; hideChatBubble defaults to false either way
					return (
						<div className="mb-4">
							<label className="text-sm text-[#a3adb8] block mb-1.5">{label}</label>
							<div className="flex rounded-md overflow-hidden border border-[#48596a]">
								<button
									onClick={() => updatePlayerTypeField(key, field, field === 'showNameLabel' ? true : true)}
									className={`flex-1 py-2 text-sm font-medium transition-colors ${value ? 'bg-[#1a56da] text-white' : 'bg-[#323d48] text-[#a3adb8] hover:bg-[#3d4a57]'}`}
								>
									True
								</button>
								<button
									onClick={() => updatePlayerTypeField(key, field, false)}
									className={`flex-1 py-2 text-sm font-medium transition-colors ${!value ? 'bg-[#1a56da] text-white' : 'bg-[#323d48] text-[#a3adb8] hover:bg-[#3d4a57]'}`}
								>
									False
								</button>
							</div>
						</div>
					);
				}

				return (
					<div className="fixed inset-0 bg-black/60 flex items-center justify-center z-20 px-4">
						<div className="bg-[#323d48] border border-[#48596a] rounded-lg p-5 w-full max-w-lg max-h-[85vh] overflow-y-auto">
							<div className="flex items-center justify-between mb-4">
								<h3 className="font-medium text-base">Player Types</h3>
								<button onClick={() => setEditingPlayerTypeKey(null)} className="text-[#8291a1] hover:text-[#c5ccd3]">
									<X size={18} />
								</button>
							</div>

							<div className="mb-4">
								<label className="text-sm text-[#a3adb8] block mb-1.5">Name</label>
								<input
									value={pt.name || ''}
									onChange={(e) => updatePlayerTypeField(key, 'name', e.target.value)}
									className="w-full bg-[#13171b] border border-[#3d4a57] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[#1a56da]"
								/>
							</div>

							<div className="mb-4">
								<label className="text-sm text-[#a3adb8] block mb-1.5">Color</label>
								<div className="flex gap-2">
									<input
										value={pt.color || ''}
										onChange={(e) => updatePlayerTypeField(key, 'color', e.target.value)}
										placeholder="white or #rrggbb"
										className="flex-1 bg-[#13171b] border border-[#3d4a57] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[#1a56da]"
									/>
									<input
										type="color"
										value={/^#[0-9a-fA-F]{6}$/.test(pt.color || '') ? pt.color : '#ffffff'}
										onChange={(e) => updatePlayerTypeField(key, 'color', e.target.value)}
										className="w-10 h-10 rounded-md border border-[#48596a] bg-[#13171b] cursor-pointer p-0.5"
										title="Pick a color"
									/>
								</div>
							</div>

							<ToggleField label="Show name label" field="showNameLabel" />
							<ToggleField label="Hide Chat Bubble" field="hideChatBubble" />

							<div className="mb-4">
								<label className="text-sm text-[#a3adb8] block mb-1.5">Hide Chat Distance</label>
								<input
									type="number"
									value={pt.hideChatDistance ?? 0}
									onChange={(e) => updatePlayerTypeField(key, 'hideChatDistance', Number(e.target.value))}
									className="w-full bg-[#13171b] border border-[#3d4a57] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[#1a56da]"
								/>
								<p className="text-[11px] text-[#637588] mt-1">Distance beyond which this team's chat bubbles are hidden from other players. 0 means no distance limit.</p>
							</div>

							<div className="mb-4">
								<label className="text-sm text-[#a3adb8] block mb-1.5">Attributes</label>
								<div className="space-y-2 mb-2">
									{Object.entries(pt.attributes || {}).map(([attrKey, attr]) => (
										<div key={attrKey} className="flex items-center gap-2 bg-[#13171b] border border-[#3d4a57] rounded-md px-3 py-2">
											<span className="text-sm flex-1 truncate">{attributeTypes[attrKey]?.name || attrKey}</span>
											<label className="text-xs text-[#8291a1]">value</label>
											<input type="number" value={attr.value ?? 0} onChange={(e) => updatePlayerTypeAttributeField(key, attrKey, 'value', Number(e.target.value))} className="w-16 bg-[#323d48] border border-[#3d4a57] rounded px-1.5 py-0.5 text-sm" />
											<button onClick={() => removePlayerTypeAttribute(key, attrKey)} className="text-[#637588] hover:text-red-400 ml-1"><X size={14} /></button>
										</div>
									))}
								</div>
								<select
									onChange={(e) => { addPlayerTypeAttribute(key, e.target.value); e.target.value = ''; }}
									defaultValue=""
									className="w-full bg-[#13171b] border border-dashed border-[#48596a] rounded-md px-2.5 py-1.5 text-sm text-[#8291a1] focus:outline-none focus:border-[#1a56da]"
								>
									<option value="" disabled>add attributes</option>
									{unusedAttrKeys.map((k) => (
										<option key={k} value={k}>{attributeTypes[k]?.name || k}</option>
									))}
								</select>
							</div>

							<div className="mb-4">
								<label className="text-sm text-[#a3adb8] block mb-1.5">Variables</label>
								<div className="space-y-2 mb-2">
									{Object.entries(pt.variables || {}).map(([varName, v]) => (
										<div key={varName} className="flex items-center gap-2 bg-[#13171b] border border-[#3d4a57] rounded-md px-3 py-2">
											<span className="text-sm flex-1 truncate">{varName}</span>
											<button onClick={() => removePlayerTypeVariable(key, varName)} className="text-[#637588] hover:text-red-400 ml-1"><X size={14} /></button>
										</div>
									))}
								</div>
								<select
									onChange={(e) => { addPlayerTypeVariable(key, e.target.value); e.target.value = ''; }}
									defaultValue=""
									className="w-full bg-[#13171b] border border-dashed border-[#48596a] rounded-md px-2.5 py-1.5 text-sm text-[#8291a1] focus:outline-none focus:border-[#1a56da]"
								>
									<option value="" disabled>add variables</option>
									{unusedVarNames.map((n) => (
										<option key={n} value={n}>{n}</option>
									))}
								</select>
							</div>

							{otherTypeEntries.length > 0 && (
								<div>
									<h4 className="text-sm text-[#a3adb8] mb-1">Diplomacy</h4>
									<p className="text-[11px] text-[#637588] mb-2">How other teams are treated by this team. Hostile, Neutral, or Friendly. Everything seen in game.json &amp; engine.</p>
									<div className="space-y-1.5">
										{otherTypeEntries.map(([otherKey, otherPt]) => (
											<div key={otherKey} className="flex items-center justify-between gap-3 bg-[#13171b] border border-[#3d4a57] rounded-md px-3 py-1.5">
												<span className="text-sm truncate">{otherPt.name || otherKey}</span>
												<select
													value={(pt.relationships || {})[otherKey] || 'neutral'}
													onChange={(e) => updatePlayerTypeRelationship(key, otherKey, e.target.value)}
													className="bg-[#323d48] border border-[#48596a] rounded-md px-2 py-1 text-sm focus:outline-none focus:border-[#1a56da]"
												>
													<option value="hostile">Hostile</option>
													<option value="neutral">Neutral</option>
													<option value="friendly">Friendly</option>
												</select>
											</div>
										))}
									</div>
								</div>
							)}
						</div>
					</div>
				);
			})()}

			{showNewModal && (
				<div className="fixed inset-0 bg-black/60 flex items-center justify-center z-20 px-4">
					<div className="bg-[#323d48] border border-[#48596a] rounded-lg p-5 w-full max-w-sm">
						<div className="flex items-center justify-between mb-4">
							<h3 className="font-medium">New {ENTITY_TABS.find((t) => t.key === activeTab)?.label.slice(0, -1)}</h3>
							<button onClick={() => setShowNewModal(false)} className="text-[#8291a1] hover:text-[#c5ccd3]">
								<X size={16} />
							</button>
						</div>
						<button
							onClick={() => startNew(null)}
							className="w-full text-left px-3 py-2 rounded-md border border-[#48596a] hover:border-[#1a56da] hover:bg-[#3d4a57]/50 mb-3 text-sm transition-colors"
						>
							Start from blank
						</button>
						<div className="text-xs text-[#8291a1] mb-1.5">...or duplicate an existing one as a starting point</div>
						<div className="flex gap-2">
							<select
								value={cloneFrom}
								onChange={(e) => setCloneFrom(e.target.value)}
								className="flex-1 bg-[#262e36] border border-[#48596a] rounded-md px-2 py-1.5 text-sm"
							>
								<option value="">Choose...</option>
								{Object.entries(categoryMap).map(([k, v]) => (
									<option key={k} value={k}>{v?.name || k}</option>
								))}
							</select>
							<button
								onClick={() => cloneFrom && startNew(cloneFrom)}
								disabled={!cloneFrom}
								className="flex items-center gap-1 px-3 py-1.5 rounded-md bg-[#1a56da] text-[#262e36] text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[#1a56da] transition-colors"
							>
								<Copy size={13} /> Clone
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

const appRoot = document.getElementById('root');
if (appRoot) createRoot(appRoot).render(<GameContentEditor />);
