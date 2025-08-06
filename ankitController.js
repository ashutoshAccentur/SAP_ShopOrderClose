sap.ui.define([
    "sap/ui/model/json/JSONModel",
    "sap/dm/dme/podfoundation/controller/PluginViewController",
    "sap/base/Log",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
], function (JSONModel, PluginViewController, Log, MessageToast,MessageBox) {
    "use strict";
 
    var oOrderNumber, oParentSFCNumber,obuildQty, oDeliveredQty;
 
    /**
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
     * Formats an ISO date string to "DD/MM/YYYY, hh:mm:ss am/pm" (Indian locale).
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
                (orderApiObj.buildQuantity !== undefined && orderApiObj.doneQuantity !== undefined)
                    ? (orderApiObj.buildQuantity - orderApiObj.doneQuantity) + " " + uom
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
         * Controller initialization. Sets up empty order model for UI table.
         */
        onInit: function () {
            // Call super (base class) init if present (important for plugin lifecycle)
            if (PluginViewController.prototype.onInit) {
                PluginViewController.prototype.onInit.apply(this, arguments);
            }
            // Initialize an empty model so the UI can bind to it without errors
            this.getView().setModel(new JSONModel({ orders: [], selectedOrderNo: "" }), "orderModel");
        },
 
        /**
         * Handler for "Filter" button press.
         * Reads all input fields, validates mandatory fields,
         * builds API request, fetches and processes results, and binds to table.
         * Shows MessageToast for any input errors or backend failures.
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
 
                // Filter by date range if both are provided (redundant if backend already filters)
                if (dateFromObj && dateToObj) {
                    ordersList = ordersList.filter(item => {
                        if (!item.scheduledStartDate || !item.scheduledCompletionDate) return false;
                        const itemStart = new Date(item.scheduledStartDate);
                        const itemEnd = new Date(item.scheduledCompletionDate);
                        // Only include orders fully within range
                        return (itemStart >= dateFromObj && itemEnd <= dateToObj);
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
               
                    if ((orderObj.executionStatus === "ACTIVE" ) || (orderObj.executionStatus === "NOT_IN_EXECUTION")) {
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
                    mappedOrder.dmReleasedQty = dmReleasedQty;
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
        },
 
        // Complete Order Button
        onCompleteOrder: async function () {
            const orderModel = this.getView().getModel("orderModel");
            const selectedOrderNo = orderModel.getProperty("/selectedOrderNo");
            const executionStatus = orderModel.getProperty("/selectedExecutionStatus");
            const plant = this.getPodController().getUserPlant();
            const baseApiUrl = this.getPublicApiRestDataSourceUri();
       
            if (!selectedOrderNo) {
                MessageToast.show("Please select an order first.");
                return;
            }
       
            if (executionStatus === "ACTIVE") {
                MessageToast.show("There are Active SFCs, Kindly Complete those SFCs first.");
                return;
            }
       
            if (executionStatus === "NOT_IN_EXECUTION") {
                // Use the correct endpoint as per your last message
                const sfcListUrl = `${baseApiUrl}/sfc/v1/worklist/sfcs?plant=${encodeURIComponent(plant)}&filter.order=${encodeURIComponent(selectedOrderNo)}`;
       
                try {
                    const sfcListResponse = await fetch(sfcListUrl);
       
                    // Robustly handle possible empty or invalid response
                    const responseText = await sfcListResponse.text();
                    let sfcs = [];
                    if (responseText.trim() !== "") {
                        try {
                            sfcs = JSON.parse(responseText);
                        } catch (e) {
                            MessageToast.show("Invalid JSON in SFC List API response.");
                            return;
                        }
                    } // else sfcs remains as []
       
                    if (!Array.isArray(sfcs) || sfcs.length === 0) {
                        MessageToast.show(`No SFCs found for Order ${selectedOrderNo}.`);
                        return;
                    }
       
                    // Filter SFCs by allowed statuses
                    const validStatusesForInvalidation = ["IN_QUEUE", "HOLD", "NEW"];
                    const sfcsToInvalidate = sfcs
                        .filter(sfc =>
                            sfc.order === selectedOrderNo &&
                            sfc.status &&
                            validStatusesForInvalidation.includes(sfc.status.description)
                        )
                        .map(sfc => sfc.sfc);
       
                    // Proceed to invalidate each SFC (one by one)
                    for (const sfcNumber of sfcsToInvalidate) {
                        const invalidateUrl = `${baseApiUrl}/sfc/v1/sfcs/invalidate?plant=${encodeURIComponent(plant)}&sfc=${encodeURIComponent(sfcNumber)}`;
       
                        try {
                            const invalidateResponse = await fetch(invalidateUrl, {
                                method: "PATCH",
                                headers: { "Content-Type": "application/json" }
                            });
       
                            if (!invalidateResponse.ok) {
                                const errorMsg = await invalidateResponse.text();
                                MessageToast.show(`Failed to invalidate SFC ${sfcNumber}: ${errorMsg}`);
                                // Continue with next SFC
                            }
                        } catch (err) {
                            MessageToast.show(`Error invalidating SFC ${sfcNumber}: ${err.message}`);
                        }
                    }
       
                    // Success message after all attempts
                    MessageToast.show("SFC deleted and order completed.");
                    // Optionally refresh the table
                    this.onFilterPress();
       
                } catch (error) {
                    MessageToast.show(`Error: ${error.message}`);
                }
            } else {
                MessageToast.show("Only orders with status ACTIVE or NOT IN EXECUTION can be completed.");
            }
        },  
       
         /*
            developed by ankit.f.kumar.gupta@accenture.com
 
        */
 
        // =============================== Adjust qty button function code start from here ===================================
 
        onAdjustQty: function() {
            var oPlant = this.getPodController().getUserPlant();
            console.log(oPlant);
            //get the qty need to update
            const qtyToUpdate = this.byId("qtyInput").getValue();
            console.log("qtyToUpdate", qtyToUpdate);
            const sUrl = this.getPublicApiRestDataSourceUri() + "/sfc/v1/sfcs/setQuantity";
            console.log(sUrl);
            var oParameters = {
                "plant": oPlant,
                "sfcQuantityRequests": [{
                    "sfc": oParentSFCNumber,
                    "quantity": qtyToUpdate // this is the new qty on that will set on parent SFC
                }]
            };
 
            //validation for qty check
 
            this.ajaxPostRequest(
                sUrl, oParameters,
                (response) => {
                    sap.m.MessageToast.show("New qty set Successfully!");
                    // console.log("Print Response:", response);
                },
                (error) => {
                    sap.m.MessageToast.show("Error while setting the new qty.\n" + error.error.message);
                    //  console.error("Print Error:", error);
                })
 
        },
 
        // =============================== Adjust qty button function code Ends here ===================================
 
 
        // =============================== Discard Order button function code start here ===================================
 
        onDiscardOrder: function() {
            var oPlant = this.getPodController().getUserPlant();
 
            const sUrl = this.getPublicApiRestDataSourceUri() + "/order/v1/orders/discard" + "?plant=" + oPlant + "&order=" + oOrderNumber;
            console.log(sUrl);
 
            this.ajaxPostRequest(
                sUrl, {},
                (response) => {
                    sap.m.MessageToast.show("Order Discarded Successfully!");
                    // console.log("Print Response:", response);
                },
                (error) => {
                    sap.m.MessageToast.show("Error while discarding Order.\n" + error);
                    //  console.error("Print Error:", error);
                })
        },
 
        // =============================== Discard Order button function code Ends here ===================================
 
        onRadioSelect: function(oEvent) {
            var oRadio = oEvent.getSource();
 
            // Get context for the RadioButton, using correct model name
            var oContext = oRadio.getBindingContext("orderModel");
 
            if (oContext) {
                var selectedData = oContext.getObject(); // data from this row
                console.log("Selected Order:", selectedData);
                oOrderNumber = selectedData.orderNo; //get order number from selected row
                //obuildQty=selectedData.bui
                oParentSFCNumber = selectedData.parentSFC; //get parent sfc number from selected row
                console.log("Order number is ", oOrderNumber, "parent sfc number is ", oParentSFCNumber)
            } else {
                console.warn("No binding context found for the selected radio button.");
            }
        }
    });
});