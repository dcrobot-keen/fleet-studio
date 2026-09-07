// 자동 생성 -- 편집 금지. `npm run gen:scan-engine-api` (scripts/gen-scan-engine-api.mjs) 가
// scan-engine/openapi.json (FastAPI server.app:app) 에서 만든다.
// eslint-disable
export interface paths {
    "/api/groups": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Api List Groups */
        get: operations["api_list_groups_api_groups_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/groups/{name}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Api Group */
        get: operations["api_group_api_groups__name__get"];
        put?: never;
        post?: never;
        /** Api Delete Group */
        delete: operations["api_delete_group_api_groups__name__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/groups/{name}/prepare": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Api Prepare */
        post: operations["api_prepare_api_groups__name__prepare_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/groups/upload": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Api Upload Group */
        post: operations["api_upload_group_api_groups_upload_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/groups/{name}/workspace": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Api Workspace
         * @description Slices + alignment + metrics + floor images as JSON (Fleet Studio native workspace).
         */
        get: operations["api_workspace_api_groups__name__workspace_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/groups/{name}/metrics": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Api Metrics */
        post: operations["api_metrics_api_groups__name__metrics_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/groups/{name}/merged.slicemap.json": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Api Merged Slicemap */
        get: operations["api_merged_slicemap_api_groups__name__merged_slicemap_json_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/groups/{name}/merged.floor.json": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Api Merged Floor Json */
        get: operations["api_merged_floor_json_api_groups__name__merged_floor_json_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/groups/{name}/alignment": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Api Get Alignment */
        get: operations["api_get_alignment_api_groups__name__alignment_get"];
        /** Api Put Alignment */
        put: operations["api_put_alignment_api_groups__name__alignment_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/groups/{name}/alignment/history": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Api Alignment History */
        get: operations["api_alignment_history_api_groups__name__alignment_history_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/groups/{name}/alignment/history/{timestamp}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Api Alignment History Entry */
        get: operations["api_alignment_history_entry_api_groups__name__alignment_history__timestamp__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/groups/{name}/icp": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Api Icp */
        post: operations["api_icp_api_groups__name__icp_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/groups/{name}/merged.png": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Api Merged Png */
        get: operations["api_merged_png_api_groups__name__merged_png_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/groups/{name}/merged.floor.png": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Api Merged Floor Png */
        get: operations["api_merged_floor_png_api_groups__name__merged_floor_png_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/groups": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Groups Index */
        get: operations["groups_index_groups_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/groups/{name}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Group Workspace */
        get: operations["group_workspace_groups__name__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/projects": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Api List Projects */
        get: operations["api_list_projects_api_projects_get"];
        put?: never;
        /** Api Create Project */
        post: operations["api_create_project_api_projects_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/projects/{name}/process": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Api Process Project */
        post: operations["api_process_project_api_projects__name__process_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/projects/{name}/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Api Get Status */
        get: operations["api_get_status_api_projects__name__status_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/projects/{name}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Api Delete Project */
        delete: operations["api_delete_project_api_projects__name__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/projects/{name}/align/geojson": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Api Align Geojson */
        post: operations["api_align_geojson_api_projects__name__align_geojson_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/projects/{name}/align/image": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Api Align Image */
        post: operations["api_align_image_api_projects__name__align_image_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        /**
         * Alignment
         * @description Pose of one scan in the group's slice plane: CCW yaw, then translate (offsetX, -offsetZ).
         */
        Alignment: {
            /** Offsetx */
            offsetX: number;
            /** Offsetz */
            offsetZ: number;
            /** Yawradians */
            yawRadians: number;
            /** Method */
            method?: string | null;
        };
        /** AlignmentEntry */
        AlignmentEntry: {
            /** Offsetx */
            offsetX: number;
            /** Offsetz */
            offsetZ: number;
            /** Yawradians */
            yawRadians: number;
            /** Method */
            method?: string | null;
            metrics?: components["schemas"]["SavedMetrics"] | null;
            /** Approved */
            approved?: boolean | null;
            /** Approved At */
            approved_at?: string | null;
        };
        /**
         * AlignmentHistoryEntry
         * @description One past save, newest first (GET /api/groups/{name}/alignment/history) -- a snapshot
         *     taken right before that save overwrote group_alignment.json, so it's always restorable.
         */
        AlignmentHistoryEntry: {
            /** Timestamp */
            timestamp: string;
            /** Scans */
            scans: number;
            /** Approved */
            approved: string[];
        };
        /**
         * AlignmentMetrics
         * @description == studio.scan_alignment_metrics.AlignmentMetrics.to_json()
         */
        AlignmentMetrics: {
            /** N Source */
            n_source: number;
            /** N Observed */
            n_observed: number;
            /** Overlap M */
            overlap_m: number;
            /** Inlier */
            inlier: number;
            /** Conflict */
            conflict: number;
            /** Rmse M */
            rmse_m?: number | null;
        };
        /** Body_api_align_geojson_api_projects__name__align_geojson_post */
        Body_api_align_geojson_api_projects__name__align_geojson_post: {
            /** Geojson */
            geojson: string;
        };
        /** Body_api_align_image_api_projects__name__align_image_post */
        Body_api_align_image_api_projects__name__align_image_post: {
            /** Image */
            image: string;
        };
        /** Body_api_create_project_api_projects_post */
        Body_api_create_project_api_projects_post: {
            /** Name */
            name: string;
        };
        /** Body_api_process_project_api_projects__name__process_post */
        Body_api_process_project_api_projects__name__process_post: {
            /** Usdz */
            usdz?: string | null;
            /** Scan File */
            scan_file?: string | null;
            /** Robot Map Pgm */
            robot_map_pgm?: string | null;
            /** Robot Map Yaml */
            robot_map_yaml?: string | null;
            /** Trajectory */
            trajectory?: string | null;
            /**
             * Remove Isolated Clusters
             * @default false
             */
            remove_isolated_clusters: boolean;
            /**
             * Isolated Cluster Min Area
             * @default 0.3
             */
            isolated_cluster_min_area: number;
            /**
             * Classify
             * @default false
             */
            classify: boolean;
        };
        /** Body_api_upload_group_api_groups_upload_post */
        Body_api_upload_group_api_groups_upload_post: {
            /** File */
            file: string;
            /** Name */
            name?: string | null;
        };
        /**
         * FloorMeta
         * @description merged.floor.json (== studio.floorplan.floor_meta).
         */
        FloorMeta: {
            /** Format */
            format: string;
            /** Resolution */
            resolution: number;
            /** Origin */
            origin: number[];
            /** Width Px */
            width_px: number;
            /** Height Px */
            height_px: number;
            /** Row0 */
            row0?: string | null;
        } & {
            [key: string]: unknown;
        };
        /**
         * FloorPayload
         * @description App floorplan.png as a data URL + where it sits (== studio.floorplan.FloorPlan.payload()).
         */
        FloorPayload: {
            /** Dataurl */
            dataUrl: string;
            /** Originx */
            originX: number;
            /** Origintopz */
            originTopZ: number;
            /** Resolution */
            resolution: number;
            /** Width */
            width: number;
            /** Height */
            height: number;
        };
        /**
         * GroupAlignmentDoc
         * @description group_alignment.json (scan-group-alignment-v1).
         */
        GroupAlignmentDoc: {
            /**
             * Format
             * @default scan-group-alignment-v1
             */
            format: string;
            /** Group */
            group?: string | null;
            /** Reference */
            reference: string;
            /** Up Axis Convention */
            up_axis_convention?: string | null;
            /** Alignments */
            alignments: {
                [key: string]: components["schemas"]["AlignmentEntry"];
            };
        } & {
            [key: string]: unknown;
        };
        /** GroupStatus */
        GroupStatus: {
            /** Name */
            name: string;
            /** Dir */
            dir: string;
            /** Reference */
            reference: string | null;
            /** Scans */
            scans: components["schemas"]["ScanStatus"][];
            /** Has Alignment */
            has_alignment: boolean;
            /** Has Merged */
            has_merged: boolean;
            /** Ready */
            ready: boolean;
            /**
             * Has Floor
             * @default false
             */
            has_floor: boolean;
        };
        /** GroupUploadResult */
        GroupUploadResult: {
            /** Status */
            status: string;
            /** Group */
            group: string;
            /** Url */
            url: string;
            /** Scans */
            scans: number;
        };
        /** HTTPValidationError */
        HTTPValidationError: {
            /** Detail */
            detail?: components["schemas"]["ValidationError"][];
        };
        /** IcpResult */
        IcpResult: {
            /** Scan */
            scan: string;
            alignment: components["schemas"]["Alignment"];
            before: components["schemas"]["AlignmentMetrics"];
            after: components["schemas"]["AlignmentMetrics"];
            /** Steps */
            steps: components["schemas"]["IcpStep"][];
            /** Moved M */
            moved_m: number;
            /** Rotated Deg */
            rotated_deg: number;
        };
        /** IcpStep */
        IcpStep: {
            /** Radius */
            radius: number;
            /** Rmse */
            rmse: number;
            /** Iterations */
            iterations: number;
        };
        /**
         * LayerPayload
         * @description One scan in the workspace: slice cells (base64 uint8 codes, row 0 = min y) + pose + metrics.
         */
        LayerPayload: {
            /** Id */
            id: string;
            /** Cols */
            cols: number;
            /** Rows */
            rows: number;
            /** Resolution */
            resolution: number;
            /** Origin */
            origin: number[];
            /** Z */
            z: number;
            /** Data */
            data: string;
            alignment: components["schemas"]["Alignment"];
            metrics?: components["schemas"]["AlignmentMetrics"] | null;
            floor?: components["schemas"]["FloorPayload"] | null;
        };
        /** MergedCells */
        MergedCells: {
            /** Cols */
            cols: number;
            /** Rows */
            rows: number;
        };
        /**
         * PoseRequest
         * @description Body of POST .../metrics and .../icp: one scan at a candidate pose, other scans' current poses.
         */
        PoseRequest: {
            /** Scan */
            scan: string;
            alignment: components["schemas"]["Alignment"];
            /** Others */
            others?: {
                [key: string]: components["schemas"]["Alignment"];
            } | null;
        };
        /**
         * ProcessStarted
         * @description POST /api/projects/{name}/process: a single scan starts the pipeline; a multi-scan zip becomes a group.
         */
        ProcessStarted: {
            /** Status */
            status: string;
            /**
             * Type
             * @enum {string}
             */
            type: "single" | "group";
            /** Name */
            name?: string | null;
            /** Has Floorplan */
            has_floorplan?: boolean | null;
            /** Group */
            group?: string | null;
            /** Group Url */
            group_url?: string | null;
            /** Message */
            message?: string | null;
        } & {
            [key: string]: unknown;
        };
        /** ProjectCreated */
        ProjectCreated: {
            /** Name */
            name: string;
        };
        /**
         * ProjectEntry
         * @description GET /api/projects item (== studio.project.list_projects).
         */
        ProjectEntry: {
            /** Name */
            name: string;
            /** Phase */
            phase: string;
            /**
             * Steps
             * @default {}
             */
            steps: {
                [key: string]: string;
            };
            /** Error */
            error?: string | null;
            /** Mtime */
            mtime: number;
        } & {
            [key: string]: unknown;
        };
        /**
         * ProjectStatus
         * @description status.json (== studio.status.read_status); phase None = never processed.
         */
        ProjectStatus: {
            /** Phase */
            phase?: string | null;
            /**
             * Steps
             * @default {}
             */
            steps: {
                [key: string]: "pending" | "active" | "done" | "skip" | "error";
            };
            /**
             * Log
             * @default []
             */
            log: string[];
            /** Error */
            error?: string | null;
        } & {
            [key: string]: unknown;
        };
        /**
         * SaveAlignmentResult
         * @description PUT /api/groups/{name}/alignment -> merged slicemap rebuilt (+ published).
         */
        SaveAlignmentResult: {
            /** Group */
            group: string;
            /** Alignment File */
            alignment_file: string;
            /** Merged */
            merged: string;
            /** Merged Summary */
            merged_summary: string;
            cells: components["schemas"]["MergedCells"];
            /** Scans */
            scans: number;
            /** Approved */
            approved: string[];
            /** Pending */
            pending: string[];
            /** Published */
            published?: string | null;
            /** Floor */
            floor?: string | null;
            /**
             * Floor Scans
             * @default []
             */
            floor_scans: string[];
            /** Published Floor */
            published_floor?: string | null;
        };
        /**
         * SavedMetrics
         * @description What the page writes into group_alignment.json per scan (rounded subset).
         */
        SavedMetrics: {
            /** Overlap M */
            overlap_m?: number | null;
            /** Inlier */
            inlier?: number | null;
            /** Conflict */
            conflict?: number | null;
            /** Rmse M */
            rmse_m?: number | null;
        } & {
            [key: string]: unknown;
        };
        /** ScanStatus */
        ScanStatus: {
            /** Id */
            id: string;
            /** Has Folder */
            has_folder: boolean;
            /** Has Usdz */
            has_usdz: boolean;
            /** Has Project */
            has_project: boolean;
            /** Has Slice */
            has_slice: boolean;
            /** Method */
            method: string;
        };
        /** SlicemapSource */
        SlicemapSource: {
            /** Scan */
            scan: string;
            /** Offsetx */
            offsetX?: number | null;
            /** Offsetz */
            offsetZ?: number | null;
            /** Yawradians */
            yawRadians?: number | null;
            /** Method */
            method?: string | null;
            /** Cells */
            cells?: number | null;
        } & {
            [key: string]: unknown;
        };
        /**
         * SlicemapV1
         * @description slicemap-v1 file (merged.slicemap.json): base64 uint8 codes 0 unknown / 1 free / 2 furniture / 3 wall.
         */
        SlicemapV1: {
            /**
             * Format
             * @constant
             */
            format: "slicemap-v1";
            /** Z */
            z: number;
            /** Band */
            band: number;
            /** Resolution */
            resolution: number;
            /** Origin */
            origin: number[];
            /** Cols */
            cols: number;
            /** Rows */
            rows: number;
            /** Data */
            data: string;
            /** Sources */
            sources?: components["schemas"]["SlicemapSource"][] | null;
        } & {
            [key: string]: unknown;
        };
        /** ValidationError */
        ValidationError: {
            /** Location */
            loc: (string | number)[];
            /** Message */
            msg: string;
            /** Error Type */
            type: string;
            /** Input */
            input?: unknown;
            /** Context */
            ctx?: Record<string, unknown>;
        };
        /** WorkspaceApi */
        WorkspaceApi: {
            /** Save */
            save: string;
            /** Icp */
            icp: string;
            /** Metrics */
            metrics?: string | null;
            /** Merged */
            merged: string;
            /** Status */
            status: string;
        };
        /** WorkspaceGates */
        WorkspaceGates: {
            /** Overlaplockm */
            overlapLockM: number;
            /** Inliermin */
            inlierMin: number;
            /** Conflictmax */
            conflictMax: number;
            /** Corrdist */
            corrDist: number;
            /** Coarsedist */
            coarseDist: number;
            /** Conflictmargin */
            conflictMargin: number;
        };
        /**
         * WorkspacePayload
         * @description GET /api/groups/{name}/workspace (== studio.align_workspace_html.workspace_payload).
         */
        WorkspacePayload: {
            /** Title */
            title: string;
            /** Group */
            group: string | null;
            /** Reference */
            reference: string;
            /** Layers */
            layers: components["schemas"]["LayerPayload"][];
            gates: components["schemas"]["WorkspaceGates"];
            api?: components["schemas"]["WorkspaceApi"] | null;
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    api_list_groups_api_groups_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GroupStatus"][];
                };
            };
        };
    };
    api_group_api_groups__name__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GroupStatus"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    api_delete_group_api_groups__name__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    api_prepare_api_groups__name__prepare_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GroupStatus"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    api_upload_group_api_groups_upload_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "multipart/form-data": components["schemas"]["Body_api_upload_group_api_groups_upload_post"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GroupUploadResult"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    api_workspace_api_groups__name__workspace_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspacePayload"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    api_metrics_api_groups__name__metrics_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PoseRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AlignmentMetrics"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    api_merged_slicemap_api_groups__name__merged_slicemap_json_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SlicemapV1"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    api_merged_floor_json_api_groups__name__merged_floor_json_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FloorMeta"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    api_get_alignment_api_groups__name__alignment_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GroupAlignmentDoc"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    api_put_alignment_api_groups__name__alignment_put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["GroupAlignmentDoc"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SaveAlignmentResult"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    api_alignment_history_api_groups__name__alignment_history_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AlignmentHistoryEntry"][];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    api_alignment_history_entry_api_groups__name__alignment_history__timestamp__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                name: string;
                timestamp: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GroupAlignmentDoc"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    api_icp_api_groups__name__icp_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PoseRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["IcpResult"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    api_merged_png_api_groups__name__merged_png_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    api_merged_floor_png_api_groups__name__merged_floor_png_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    groups_index_groups_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/html": string;
                };
            };
        };
    };
    group_workspace_groups__name__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/html": string;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    api_list_projects_api_projects_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProjectEntry"][];
                };
            };
        };
    };
    api_create_project_api_projects_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/x-www-form-urlencoded": components["schemas"]["Body_api_create_project_api_projects_post"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProjectCreated"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    api_process_project_api_projects__name__process_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "multipart/form-data": components["schemas"]["Body_api_process_project_api_projects__name__process_post"];
            };
        };
        responses: {
            /** @description Successful Response */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProcessStarted"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    api_get_status_api_projects__name__status_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProjectStatus"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    api_delete_project_api_projects__name__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    api_align_geojson_api_projects__name__align_geojson_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "multipart/form-data": components["schemas"]["Body_api_align_geojson_api_projects__name__align_geojson_post"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    api_align_image_api_projects__name__align_image_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "multipart/form-data": components["schemas"]["Body_api_align_image_api_projects__name__align_image_post"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
}
