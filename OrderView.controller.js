// Main controller for the Complete Order plugin in SAP DM
sap.ui.define([
    // SAPUI5 modules and dependencies required for this plugin
    "sap/ui/model/json/JSONModel",
    "sap/dm/dme/podfoundation/controller/PluginViewController",
    "sap/base/Log",
    "sap/m/MessageToast"
], function (JSONModel, PluginViewController, Log, MessageToast) {
    "use strict";

    /**
     * ashutosh.d.kashyap
     * Extract the UOM (Unit of Measure) for an order from the backend object.
     * Tries in order: production UOM, ERP UOM, base UOM. Returns "" if not found.
     * @param {object} orderApiObj - The raw order object from API.
     * @returns {string} - Unit of Measure or "".
     */
    function getOrderUOM(orderApiObj) {
        // Prefer the most specific UOM if available
        if (orderApiObj.productionUnitOfMeasureObject && orderApiObj.productionUnitOfMeasureObject.uom) {
            return orderApiObj.productionUnitOfMeasureObject.uom;
        }
        if (orderApiObj.erpUnitOfMeasure) {
            return orderApiObj.erpUnitOfMeasure;
        }
        if (orderApiObj.baseUnitOfMeasureObject && orderApiObj.baseUnitOfMeasureObject.uom) {
            return orderApiObj.baseUnitOfMeasureObject.uom;
        }
        return "";
    }

    /**
     * ashutosh.d.kashyap
     * Formats an ISO date string to "MM/DD/YYYY, hh:mm:ss am/pm" (Indian locale).
     * Returns "-" if input is invalid.
     * @param {string} dateStr - ISO date string.
     * @returns {string}
     */
    function formatDate(dateStr) {
        if (!dateStr) return "-";
        try {
            const date = new Date(dateStr);
            if (isNaN(date.getTime())) return "-";
            // Format: 'Jul 31, 2025, 6:00:30 PM'
            return date.toLocaleString('en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
                second: '2-digit',
                hour12: true
            });
        } catch {
            return "-";
        }
    }
    

    /**
     * ashutosh.d.kashyap
     * Parse and validate a SAPUI5 DatePicker value to a Date object.
     * Returns null if the value is empty or not a valid date.
     * @param {sap.m.DatePicker} oDatePicker - The DatePicker instance.
     * @returns {Date|null}
     */
    function parseDatePickerValue(oDatePicker) {
        if (!oDatePicker) return null;
        const value = oDatePicker.getValue();
        if (!value) return null;
        // Handles both ISO and formatted values (browser dependent)
        const dt = new Date(value);
        return isNaN(dt.getTime()) ? null : dt;
    }

    /**
     * ashutosh.d.kashyap
     * Maps a raw API order object to a UI table row object for model binding.
     * Handles missing fields, formatting, and aggregates UI-friendly values.
     * @param {object} orderApiObj - Raw order object from API.
     * @returns {object} - Row object for table/model.
     */
    function mapOrderApiToUiRow(orderApiObj) {
        const uom = getOrderUOM(orderApiObj);
        return {
            orderNo: orderApiObj.order || "-",
            parentSFC: "-", // Default, will be filled later asynchronously if needed
            materialLine: orderApiObj.material
                ? (orderApiObj.material.material + " / " + (orderApiObj.material.version || ""))
                : "-",
            materialDesc: orderApiObj.material?.description || "",
            executionStatus: orderApiObj.executionStatus || "-",
            buildQty: orderApiObj.buildQuantity !== undefined ? orderApiObj.buildQuantity + " " + uom : "-",
            doneQty: orderApiObj.doneQuantity !== undefined ? orderApiObj.doneQuantity + " " + uom : "-",
            dmReleasedQty: "-", // Default, will be filled later asynchronously if needed
            availableQty:
                (orderApiObj.buildQuantity !== undefined && orderApiObj.releasedQuantity !== undefined)
                    ? (orderApiObj.buildQuantity - orderApiObj.releasedQuantity) + " " + uom
                    : "-",
            scheduledStartEnd: formatDate(orderApiObj.scheduledStartDate) + "\n" + formatDate(orderApiObj.scheduledCompletionDate),
            scheduledStartDate: orderApiObj.scheduledStartDate,
            scheduledCompletionDate: orderApiObj.scheduledCompletionDate,
            priority: orderApiObj.priority || "-",

            enabled: ["ACTIVE", "NOT_IN_EXECUTION"].includes(orderApiObj.executionStatus)
        };
    }
    

    // === Controller definition for Order View (main class) ===

    return PluginViewController.extend("bobm.custom.completeorderplugin.orderviewplugin.controller.OrderView", {
        metadata: { properties: {} },

        /**
         * ashutosh.d.kashyap
         * Controller initialization. 
         * Sets up the default JSON model for orders table and selection tracking.
         */
        onInit: function () {
            // Call super (base class) init if present (important for plugin lifecycle)
            if (PluginViewController.prototype.onInit) {
                PluginViewController.prototype.onInit.apply(this, arguments);
            }
            // Initialize selectedExecutionStatus for tracking selected order status
            this.getView().setModel(new JSONModel({
                orders: [],
                selectedOrderNo: "",
                selectedExecutionStatus: ""
            }), "orderModel");
        },

        /**
         * ashutosh.d.kashyap
         * Handler for "Filter" button press.
         * Reads all input fields, validates mandatory fields,
         * builds API request, fetches and processes results, and binds to table.
         * Shows MessageToast for any input errors or backend failures.
         * Updates the table model for display
         */
        onFilterPress: function () {
            // Gather input controls by their IDs
            const oMaterial = this.byId("materialInput");
            const oExecutionStatus = this.byId("executionStatusSelect");
            const oOrderNo = this.byId("orderNoInput");
            const oDateFrom = this.byId("dateFromInput");
            const oDateTo = this.byId("dateToInput");
            const oItemsHeading = this.byId("itemsHeading"); // item count display
        
            // Extract/normalize values
            const material = oMaterial ? oMaterial.getValue().trim() : "";
            const executionStatus = oExecutionStatus ? oExecutionStatus.getSelectedKey() : "";
            const orderNumber = oOrderNo ? oOrderNo.getValue().trim() : "";
            const dateFromObj = parseDatePickerValue(oDateFrom);
            const dateToObj = parseDatePickerValue(oDateTo);

            const hasMaterial = !!material;
            const hasExecStatus = !!executionStatus;
            const hasOrder = !!orderNumber;
            const hasDateFrom = !!dateFromObj;
            const hasDateTo = !!dateToObj;

            // === Validation section ===
            if ((hasDateFrom && !hasDateTo) || (!hasDateFrom && hasDateTo)) {
                MessageToast.show("Please provide both 'Date From' and 'Date To' to search by date range.");
                return;
            }
            if (!hasMaterial && !hasExecStatus && !hasOrder && !(hasDateFrom && hasDateTo)) {
                MessageToast.show("Please provide at least one search parameter.");
                return;
            }
            // From date cannot be after To date
            if (dateFromObj && dateToObj && dateFromObj > dateToObj) {
                MessageToast.show("Date From cannot be later than Date To.");
                return;
            }

            // === Preparing API parameters ===

            // Convert dates to API-friendly format (YYYY-MM-DD)
            const dateFromStr = dateFromObj ? dateFromObj.toISOString().substring(0, 10) : null;
            const dateToStr = dateToObj ? dateToObj.toISOString().substring(0, 10) : null;

            // Fetch plant from pod controller, which may depend on logged-in user/session
            const oPlant = this.getPodController().getUserPlant();

            // Backend API endpoint for order list
            const sListUrl = this.getPublicApiRestDataSourceUri() + "/order/v1/orders/list"; // Order List api

            // Query parameters for API call

            const params = { size: 200, page: 0 };

            // Always set plant
            params.plant = oPlant;
            
            // Only add if value is present (not empty string/null)
            if (material) params.material = material;
            if (executionStatus) params.executionStatus = executionStatus;
            if (orderNumber) params.orderNumber = orderNumber;
            if (dateFromStr) params.dateFrom = dateFromStr;
            if (dateToStr) params.dateTo = dateToStr;
                        

            // === Actual backend fetch ===

            fetch(sListUrl + "?" + new URLSearchParams(params).toString())
            .then(response => {
                if (!response.ok) throw new Error("Server/API error");
                return response.json();
            })
            .then(async apiData => {
                let ordersList = apiData.content || [];

                // === Client-side post-filtering (for extra safety) ===

                // Filter by date range if both are provided (scheduledStartDate MUST be within the range, inclusive)
                if (dateFromObj && dateToObj) {
                    ordersList = ordersList.filter(item => {
                        if (!item.scheduledStartDate) return false;
                        const itemStart = new Date(item.scheduledStartDate);
                        // Only include if scheduledStartDate falls within [dateFromObj, dateToObj] (inclusive)
                        return (itemStart >= dateFromObj && itemStart <= dateToObj);
                    });
                }


                // Filter by execution status, if specified (extra check, as backend should already filter)
                if (executionStatus) {
                    ordersList = ordersList.filter(item =>
                        item.executionStatus && item.executionStatus === executionStatus
                    );
                }

                // Client-side filter for order number (in case backend search is partial or exact)
                if (orderNumber) {
                    ordersList = ordersList.filter(item =>
                        item.order && item.order.includes(orderNumber)
                    );
                }

                // === Enrich orders with Parent SFC (asynchronously for each row) ===

                // For each order, if ACTIVE, call detail API to get SFCs and pick Parent SFC
                const enhancedOrders = await Promise.all(ordersList.map(async (orderObj) => {
                    let parentSFC = "-";
                    let dmReleasedQty = "-";  // Default
                
                    if (orderObj.executionStatus === "ACTIVE" || orderObj.executionStatus === "NOT_IN_EXECUTION") {
                        const orderDetailUrl = `${this.getPublicApiRestDataSourceUri()}/order/v1/orders?plant=${encodeURIComponent(oPlant)}&order=${encodeURIComponent(orderObj.order)}`;
                        try {
                            const orderDetailResponse = await fetch(orderDetailUrl);
                            if (orderDetailResponse.ok) {
                                const orderDetailData = await orderDetailResponse.json();
                                let sfcs = orderDetailData.sfcs || [];
                                // Find first SFC containing the order string (case-sensitive)
                                let foundSFC = undefined;
                                if (orderObj.order && Array.isArray(sfcs)) {
                                    foundSFC = sfcs.find(sfcName => sfcName.includes(orderObj.order));
                                }
                                if (foundSFC) {
                                    parentSFC = foundSFC;
                
                                    // Fetch DM Released Qty from SFC Detail API
                                    const sfcDetailUrl = `${this.getPublicApiRestDataSourceUri()}/sfc/v1/sfcdetail?plant=${encodeURIComponent(oPlant)}&sfc=${encodeURIComponent(foundSFC)}`; //SFC detail api
                                    try {
                                        const sfcDetailResponse = await fetch(sfcDetailUrl);
                                        if (sfcDetailResponse.ok) {
                                            const sfcDetailData = await sfcDetailResponse.json();
                                            // The DM released quantity is in "quantity"
                                            if (
                                                sfcDetailData &&
                                                typeof sfcDetailData.quantity !== "undefined" &&
                                                sfcDetailData.quantity !== null
                                            ) {
                                                dmReleasedQty = sfcDetailData.quantity.toString();
                                            } else {
                                                dmReleasedQty = "-";
                                            }
                                        } else {
                                            dmReleasedQty = "-";
                                        }
                                    } catch (sfcErr) {
                                        dmReleasedQty = "-";
                                    }
                                } else {
                                    parentSFC = "-";
                                    dmReleasedQty = "-";
                                }
                            }
                        } catch (error) {
                            parentSFC = "-";
                            dmReleasedQty = "-";
                        }
                    }
                    const mappedOrder = mapOrderApiToUiRow(orderObj);
                    mappedOrder.parentSFC = parentSFC;
                    const uom = getOrderUOM(orderObj);
                    // Only add unit if value is a number/string (not "-")
                    mappedOrder.dmReleasedQty = (dmReleasedQty !== "-") ? `${dmReleasedQty} ${uom}` : "-";
                    return mappedOrder;
                }));


                // Bind final, enriched list to table model for display
                this.getView().getModel("orderModel").setProperty("/orders", enhancedOrders);
                this.getView().getModel("orderModel").setProperty("/selectedOrderNo", "");  // RESET selection here

                // Update item count in table heading
                if (oItemsHeading && oItemsHeading.setText) {
                    oItemsHeading.setText(`Items (${enhancedOrders.length.toString().padStart(2, "0")})`);
                }
            })
            .catch(err => {
                // Any error: showing user-friendly message, clear table, reset count
                MessageToast.show("Failed to fetch orders: " + err.message);
                this.getView().getModel("orderModel").setProperty("/orders", []);
                if (oItemsHeading && oItemsHeading.setText) {
                    oItemsHeading.setText("Items (00)");
                }
            });
        },


        

        /**
         * ashutosh.d.kashyap
         * Handles the Complete Order button click.
         * Checks order selection and status
         * Acts on two types of Order ("Active" & "Not-In-Execution")
         * For Active one, throws message to Go and complete the open SFCs
         * For NOT_IN_EXECUTION: fetches SFCs in (NEW, IN_QUEUE, or HOLD status)
         * Invalidates these SFCs using PATCH, this will delete and Complete that Order.
         * Shows MessageToast for any input errors or backend failures.
         */
        onCompleteOrder: async function () {
            const orderModel = this.getView().getModel("orderModel");
            const selectedOrderNo = orderModel.getProperty("/selectedOrderNo");
            const plant = this.getPodController().getUserPlant();
            const baseApiUrl = this.getPublicApiRestDataSourceUri();
        
            if (!selectedOrderNo) {
                MessageToast.show("Please select an order first.");
                return;
            }
        
            // Fetch Parent SFC value for selected order from model
            const orders = orderModel.getProperty("/orders") || [];
            const selectedOrderObj = orders.find(o => o.orderNo === selectedOrderNo);
            const parentSFC = selectedOrderObj && selectedOrderObj.parentSFC && selectedOrderObj.parentSFC !== "-" ? selectedOrderObj.parentSFC : null;
        
            let isParentSfcDeleted = false;
        
            try {
                if (parentSFC) {
                    // 1. Get SFC detail to check Parent SFC status
                    const sfcDetailUrl = `${baseApiUrl}/sfc/v1/sfcdetail?plant=${encodeURIComponent(plant)}&sfc=${encodeURIComponent(parentSFC)}`;
                    const sfcDetailResponse = await fetch(sfcDetailUrl, { credentials: "include" });
        
                    if (sfcDetailResponse.ok) {
                        const sfcDetail = await sfcDetailResponse.json();
                        const sfcStatusDesc = sfcDetail.status && sfcDetail.status.description;
        
                        if (String(sfcStatusDesc).toUpperCase() === "NEW") {
                            // Invalidate Parent SFC
                            const invalidateUrl = `${baseApiUrl}/sfc/v1/sfcs/invalidate?plant=${encodeURIComponent(plant)}&sfc=${encodeURIComponent(parentSFC)}`;
                            await new Promise((resolve) => {
                                this.ajaxPatchRequest(
                                    invalidateUrl,
                                    {},
                                    (response) => {
                                        MessageToast.show("Parent SFC deleted.");
                                        isParentSfcDeleted = true;
                                        resolve();
                                    },
                                    (error) => {
                                        // Still proceed to Complete Order even if invalidate fails
                                        MessageToast.show("Failed to invalidate Parent SFC: " + (error && error.error && error.error.message ? error.error.message : ""));
                                        resolve();
                                    }
                                );
                            });
                            // Wait for 2 seconds before running Complete Order
                            await new Promise(res => setTimeout(res, 2000));
                        }
                    }
                    // If SFC detail call failed or Parent SFC not in NEW, just move to Complete Order below
                }
        
                // 2. Run Complete Order API regardless of anything above
                const completeOrderUrl = `${baseApiUrl}/order/v1/orders/complete?order=${encodeURIComponent(selectedOrderNo)}&plant=${encodeURIComponent(plant)}`;
                await new Promise((resolve) => {
                    this.ajaxPostRequest(
                        completeOrderUrl,
                        {},
                        (response) => {
                            // Show the response message from the API (success)
                            if (response && response.message) {
                                MessageToast.show(response.message);
                            } else {
                                MessageToast.show("Order completion request processed.");
                            }
                            this.onFilterPress(); // Refresh table
                            resolve();
                        },
                        (error) => {
                            // Always show API error message as in postman
                            let apiMessage = null;
                            if (error) {
                                if (typeof error === "string") {
                                    try {
                                        const errObj = JSON.parse(error);
                                        apiMessage = errObj.message || errObj.error?.message;
                                    } catch {
                                        apiMessage = error;
                                    }
                                } else if (typeof error === "object") {
                                    apiMessage = error.message || error.error?.message;
                                }
                            }
                            MessageToast.show(apiMessage || "Failed to complete order.");
                            this.onFilterPress();
                            resolve();
                        }
                    );
                });
        
            } catch (error) {
                MessageToast.show("Unexpected error: " + error.message);
            }
        },
                                



        /**
         * ashutosh.d.kashyap
         * Handles radio button select event for table row.
         * Updates the selected order number and execution status in the model.
         */          
        onRadioSelect: function(oEvent) {
            const oContext = oEvent.getSource().getBindingContext("orderModel");
            const orderNo = oContext.getProperty("orderNo");
            const executionStatus = oContext.getProperty("executionStatus");
        
            // Save the selected orderNo and executionStatus into your model
            const orderModel = this.getView().getModel("orderModel");
            orderModel.setProperty("/selectedOrderNo", orderNo);
            orderModel.setProperty("/selectedExecutionStatus", executionStatus);
        },


            
        /**
         * Helper: Fetch CSRF token for a URL (needed for PATCH/POST/DELETE in SAP REST APIs)
         * Always uses GET method and 'X-CSRF-Token: Fetch' header.
         * @param {string} url - The URL to fetch token from (use GET endpoint of your service)
         * @returns {Promise<string|null>} - The CSRF token, or null if not found
         */
        // fetchCsrfToken: async function(url) {
        //     const res = await fetch(url, {
        //         method: "GET",
        //         headers: { "X-CSRF-Token": "Fetch" },
        //         credentials: "include" // needed for cookies/session in SAP
        //     });
        //     return res.headers.get("x-csrf-token");
        // },
        

        /**
         * Wrapper utility for AJAX GET requests (legacy fallback in this app).
         * Calls provided success/error callbacks.
         */
        executeAjaxGetRequestSuccessCallback: function (sUrl, oParameters, fnSuccessCallback, fnErrorCallback) {
            this.ajaxGetRequest(
                sUrl,
                oParameters,
                (oResponse) => {
                    if (fnSuccessCallback) {
                        fnSuccessCallback(oResponse);
                    }
                },
                (oError, sHttpErrorMessage) => {
                    if (fnErrorCallback) {
                        fnErrorCallback(oError);
                    } else {
                        Log.error("AJAX GET failed:", sHttpErrorMessage, oError);
                        MessageToast.show("AJAX request failed.");
                    }
                }
            );
        }
    });
});
