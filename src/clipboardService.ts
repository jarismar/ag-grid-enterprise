import {
    Bean,
    RangeSelection,
    CsvExportParams,
    ColDef,
    IClipboardService,
    Autowired,
    ProcessCellForExportParams,
    CsvCreator,
    LoggerFactory,
    SelectionController,
    IRowModel,
    FloatingRowModel,
    ValueService,
    FocusedCellController,
    RowRenderer,
    ColumnController,
    EventService,
    CellNavigationService,
    GridOptionsWrapper,
    Logger,
    PostConstruct,
    GridRow,
    Utils,
    GridCore,
    GridCell,
    Events,
    RowNode,
    Column,
    Constants
} from "ag-grid/main";
import {RangeController} from "./rangeController";

interface RowCallback {
    (gridRow: GridRow, rowNode: RowNode, columns: Column[]): void
}

interface ColumnCallback {
    (columns: Column[]): void
}

@Bean('clipboardService')
export class ClipboardService implements IClipboardService {

    @Autowired('csvCreator') private csvCreator: CsvCreator;
    @Autowired('loggerFactory') private loggerFactory: LoggerFactory;
    @Autowired('selectionController') private selectionController: SelectionController;
    @Autowired('rangeController') private rangeController: RangeController;
    @Autowired('rowModel') private rowModel: IRowModel;
    @Autowired('floatingRowModel') private floatingRowModel: FloatingRowModel;
    @Autowired('valueService') private valueService: ValueService;
    @Autowired('focusedCellController') private focusedCellController: FocusedCellController;
    @Autowired('rowRenderer') private rowRenderer: RowRenderer;
    @Autowired('columnController') private columnController: ColumnController;
    @Autowired('eventService') private eventService: EventService;
    @Autowired('cellNavigationService') private cellNavigationService: CellNavigationService;
    @Autowired('gridOptionsWrapper') private gridOptionsWrapper: GridOptionsWrapper;
    @Autowired('gridCore') private gridCore: GridCore;

    private logger: Logger;

    @PostConstruct
    private init(): void {
        this.logger = this.loggerFactory.create('ClipboardService');
    }

    public pasteFromClipboard(): void {
        this.logger.log('pasteFromClipboard');
        this.executeOnTempElement(
            (textArea: HTMLTextAreaElement)=> {
                textArea.focus();
            },
            (element: HTMLTextAreaElement)=> {
                var text = element.value;
                this.finishPasteFromClipboard(text);
            }
        );
    }

    public copyRangeDown(): void {
        if (this.rangeController.isEmpty()) { return; }

        var cellsToFlash = <any>{};
        var firstRowValues: any[] = null;

        var updatedRowNodes: RowNode[] = [];
        var updatedColumnIds: string[] = [];

        var rowCallback = (currentRow: GridRow, rowNode: RowNode, columns: Column[]) => {
            // take reference of first row, this is the one we will be using to copy from
            if (!firstRowValues) {
                firstRowValues = [];
                // two reasons for looping through columns
                columns.forEach( column => {
                    // reason 1 - to get the initial values to copy down
                    var value = this.valueService.getValue(column, rowNode);
                    firstRowValues.push(value);
                    // reason 2 - to record the columnId for refreshing
                    updatedColumnIds.push(column.getId());
                });
            } else {
                // otherwise we are not the first row, so copy
                updatedRowNodes.push(rowNode);
                columns.forEach( (column: Column, index: number) => {
                    if (!column.isCellEditable(rowNode)) { return; }

                    var firstRowValue = firstRowValues[index];
                    this.valueService.setValue(rowNode, column, firstRowValue);

                    var cellId = new GridCell(currentRow.rowIndex, currentRow.floating, column).createId();
                    cellsToFlash[cellId] = true;
                });
            }
        };

        this.iterateActiveRanges(true, rowCallback);

        // this is very heavy, should possibly just refresh the specific cells?
        this.rowRenderer.refreshCells(updatedRowNodes, updatedColumnIds);

        this.eventService.dispatchEvent(Events.EVENT_FLASH_CELLS, {cells: cellsToFlash});
    }

    private finishPasteFromClipboard(data: string) {
        if (Utils.missingOrEmpty(data)) { return; }

        var focusedCell = this.focusedCellController.getFocusedCell();
        if (!focusedCell) { return; }

        var parsedData = this.dataToArray(data);
        if (!parsedData) {
            return;
        }

        // remove last row if empty, excel puts empty last row in
        var lastLine = parsedData[parsedData.length - 1];
        if (lastLine.length===1 && lastLine[0]==='') {
            Utils.removeFromArray(parsedData, lastLine);
        }

        var currentRow = new GridRow(focusedCell.rowIndex, focusedCell.floating);
        var cellsToFlash = <any>{};

        var updatedRowNodes: RowNode[] = [];
        var updatedColumnIds: string[] = [];

        let columnsToPasteInto = this.columnController.getDisplayedColumnsStartingAt(focusedCell.column);

        parsedData.forEach( (values: string[]) => {
            // if we have come to end of rows in grid, then skip
            if (!currentRow) { return; }

            let rowNode = this.getRowNode(currentRow);
            updatedRowNodes.push(rowNode);

            values.forEach( (value: any, index: number)=> {
                let column = columnsToPasteInto[index];

                if (Utils.missing(column)) { return; }
                if (!column.isCellEditable(rowNode)) { return; }

                let processedValue = this.processRangeCell(rowNode, column, value, this.gridOptionsWrapper.getProcessCellFromClipboardFunc());

                this.valueService.setValue(rowNode, column, processedValue);
                var cellId = new GridCell(currentRow.rowIndex, currentRow.floating, column).createId();
                cellsToFlash[cellId] = true;

                if (updatedColumnIds.indexOf(column.getId()) < 0) {
                    updatedColumnIds.push(column.getId());
                }
            });
            // move to next row down for next set of values
            currentRow = this.cellNavigationService.getRowBelow(currentRow);
        });

        // this is very heavy, should possibly just refresh the specific cells?
        this.rowRenderer.refreshCells(updatedRowNodes, updatedColumnIds);

        this.eventService.dispatchEvent(Events.EVENT_FLASH_CELLS, {cells: cellsToFlash});

        this.focusedCellController.setFocusedCell(focusedCell.rowIndex, focusedCell.column, focusedCell.floating, true);
    }

    public copyToClipboard(includeHeaders = false): void {
        this.logger.log(`copyToClipboard: includeHeaders = ${includeHeaders}`);

        var selectedRowsToCopy = !this.selectionController.isEmpty()
            && !this.gridOptionsWrapper.isSuppressCopyRowsToClipboard();

        // default is copy range if exists, otherwise rows
        if (this.rangeController.isMoreThanOneCell()) {
            this.copySelectedRangeToClipboard(includeHeaders);
        } else if (selectedRowsToCopy) {
            this.copySelectedRowsToClipboard(includeHeaders);
        } else if (!this.rangeController.isEmpty()) {
            this.copySelectedRangeToClipboard(includeHeaders);
        }
    }

    private iterateActiveRanges(onlyFirst: boolean, rowCallback: RowCallback, columnCallback?: ColumnCallback): void {
        if (this.rangeController.isEmpty()) { return; }

        var rangeSelections = this.rangeController.getCellRanges();

        if (onlyFirst) {
            let range = rangeSelections[0];
            this.iterateActiveRange(range, rowCallback, columnCallback);
        } else {
            rangeSelections.forEach( range => this.iterateActiveRange(range, rowCallback, columnCallback) );
        }
    }

    private iterateActiveRange(range: RangeSelection, rowCallback: RowCallback, columnCallback?: ColumnCallback): void {
        // get starting and ending row, remember rowEnd could be before rowStart
        var startRow = range.start.getGridRow();
        var endRow = range.end.getGridRow();

        var startRowIsFirst = startRow.before(endRow);

        var currentRow = startRowIsFirst ? startRow : endRow;
        var lastRow = startRowIsFirst ? endRow : startRow;

        if (Utils.exists(columnCallback)) {
            columnCallback(range.columns);
        }

        while (true) {

            var rowNode = this.getRowNode(currentRow);
            rowCallback(currentRow, rowNode, range.columns);

            if (currentRow.equals(lastRow)) {
                break;
            }

            currentRow = this.cellNavigationService.getRowBelow(currentRow);
        }
    }

    public copySelectedRangeToClipboard(includeHeaders = false): void {
        if (this.rangeController.isEmpty()) { return; }

        var data = '';
        var cellsToFlash = <any>{};
        const dataObj = {
            colDefs: [],
            headings: [],
            rows:[]
        };

        // adds columns to the data
        var columnCallback = (columns: Column[]) => {
            if (!includeHeaders) { return; }

            columns.forEach( (column, index) => {
                var value = this.columnController.getDisplayNameForColumn(column, 'clipboard', true);
                if (index != 0) {
                    data += '\t';
                }
                if (Utils.exists(value)) {
                    dataObj.headings.push(value);
                    data += value;
                } else {
                    dataObj.headings.push('');
                }
            });

            data += '\r\n';
        };

        // adds cell values to the data
        var rowCallback = (currentRow: GridRow, rowNode: RowNode, columns: Column[]) => {
            const row = [];
            columns.forEach( (column, index) => {
                var value = this.valueService.getValue(column, rowNode);

                let processedValue = this.processRangeCell(rowNode, column, value, this.gridOptionsWrapper.getProcessCellForClipboardFunc());

                if (index != 0) {
                    data += '\t';
                }

                if (dataObj.rows.length === 0) {
                    dataObj.colDefs.push(column);
                }

                if (Utils.exists(processedValue)) {
                    row.push(processedValue);
                    data += processedValue;
                } else {
                    row.push('');
                }
                var cellId = new GridCell(currentRow.rowIndex, currentRow.floating, column).createId();
                cellsToFlash[cellId] = true;
            });

            dataObj.rows.push(row);
            data += '\r\n';
        };

        this.iterateActiveRanges(false, rowCallback, columnCallback);
        this.copyDataToClipboard(data, dataObj);
        this.eventService.dispatchEvent(Events.EVENT_FLASH_CELLS, {cells: cellsToFlash});
    }

    private processRangeCell(rowNode: RowNode, column: Column, value: any, func: (params: ProcessCellForExportParams) => void ): any {
        if (func) {
            return func({
                column: column,
                node: rowNode,
                value: value,
                api: this.gridOptionsWrapper.getApi(),
                columnApi: this.gridOptionsWrapper.getColumnApi(),
                context: this.gridOptionsWrapper.getContext()
            });
        } else {
            return value;
        }
    }

    private getRowNode(gridRow: GridRow): RowNode {
        switch (gridRow.floating) {
            case Constants.FLOATING_TOP:
                return this.floatingRowModel.getFloatingTopRowData()[gridRow.rowIndex];
            case Constants.FLOATING_BOTTOM:
                return this.floatingRowModel.getFloatingBottomRowData()[gridRow.rowIndex];
            default:
                return this.rowModel.getRow(gridRow.rowIndex);
        }
    }

    public copySelectedRowsToClipboard(includeHeaders = false, columnKeys?: (string|Column|ColDef)[]): void {

        var skipHeader = !includeHeaders;

        var params: CsvExportParams = {
            columnKeys: columnKeys,
            skipHeader: skipHeader,
            skipFooters: true,
            columnSeparator: '\t',
            onlySelected: true,
            processCellCallback: this.gridOptionsWrapper.getProcessCellForClipboardFunc()
        };

        var data = this.csvCreator.getDataAsCsv(params);

        this.copyDataToClipboard(data);
    }

    private htmlFormatter(dataObj?: any): string {
        const table = document.createElement('table');
        const thead = table.createTHead();
        const tbody = table.createTBody();
        const borderStyle = 'solid 1px #a9a9a9';
        const fontStyle = 'Helvetica Neue, Helvetica, Arial, sans-serif';

        table.cellSpacing = '0';
        table.style.borderCollapse = 'collapse';

        if (dataObj.headings.length > 0) {
            const tr = thead.insertRow(0);
            dataObj.headings.forEach((heading: string, index: number) => {
                const td = tr.insertCell(index);
                td.innerText = heading;
                td.style.color = '#666';
                td.style.backgroundColor = '#eee';
                td.style.padding = '4px 8px';
                td.style.fontWeight = 'bold';
                td.style.fontFamily = fontStyle;
                td.style.fontSize = '11px';
                td.style.border = borderStyle;

                if (dataObj.colDefs[index].getFilter() === 'number') {
                    td.style.textAlign = 'right';
                } else {
                    td.style.textAlign = 'center';
                }
            });
        }

        dataObj.rows.forEach((row: any, rowIndex: number) => {
            const tr = tbody.insertRow(rowIndex);

            row.forEach((cellValue: any, cellIndex: number) => {
                const td = tr.insertCell(cellIndex);
                td.innerText = cellValue;
                td.style.color = '#666';
                td.style.padding = '4px 8px';
                td.style.fontFamily = fontStyle;
                td.style.fontSize = '11px';
                td.style.border = borderStyle;

                if (dataObj.colDefs[cellIndex].getFilter() === 'number') {
                    td.style.textAlign = 'right';
                } else {
                    td.style.textAlign = 'left';
                }
            });
        });

        return new XMLSerializer().serializeToString(table);
    }

    private copyDataToClipboard(data: string, dataObj?: any): void {
        this.executeOnTempElement( (element: HTMLTextAreaElement)=> {
            element.value = data;
            element.select();
            element.focus();

            element.addEventListener('copy', (event) => {
                event.clipboardData.clearData('text/plain');
                event.clipboardData.clearData('text/html');

                event.clipboardData.setData('text/plain', data);

                const hasMoreThanOneCell = dataObj && (
                    dataObj.headings.length > 0 ||
                    dataObj.rows.length > 1 ||
                    (dataObj.rows.length > 0 && dataObj.rows[0].length > 1));

                if (hasMoreThanOneCell) {
                    event.clipboardData.setData('text/html', this.htmlFormatter(dataObj));
                }

                event.preventDefault();
            });

            return document.execCommand('copy');
        });
    }

    private executeOnTempElement(
        callbackNow: (element: HTMLTextAreaElement)=>void,
        callbackAfter?: (element: HTMLTextAreaElement)=>void): void {

        var eTempInput = <HTMLTextAreaElement> document.createElement('textarea');
        eTempInput.style.width = '1px';
        eTempInput.style.height = '1px';
        eTempInput.style.top = '0px';
        eTempInput.style.left = '0px';
        eTempInput.style.position = 'absolute';
        eTempInput.style.opacity = '0.0';

        var guiRoot = this.gridCore.getRootGui();

        guiRoot.appendChild(eTempInput);

        try {
            var result = callbackNow(eTempInput);
            this.logger.log('Clipboard operation result: ' + result);
        } catch (err) {
            this.logger.log('Browser doesn\t support document.execComment(\'copy\') for clipboard operations');
        }

        if (callbackAfter) {
            setTimeout( ()=> {
                callbackAfter(eTempInput);
                guiRoot.removeChild(eTempInput);
            }, 0);
        } else {
            guiRoot.removeChild(eTempInput);
        }
    }

    // From http://stackoverflow.com/questions/1293147/javascript-code-to-parse-csv-data
    // This will parse a delimited string into an array of
    // arrays. The default delimiter is the comma, but this
    // can be overriden in the second argument.
    private dataToArray(strData: string): string[][] {
        var strDelimiter = '\t';

        // Create a regular expression to parse the CSV values.
        var objPattern = new RegExp(
            (
                // Delimiters.
                "(\\" + strDelimiter + "|\\r?\\n|\\r|^)" +
                // Quoted fields.
                "(?:\"([^\"]*(?:\"\"[^\"]*)*)\"|" +
                // Standard fields.
                "([^\"\\" + strDelimiter + "\\r\\n]*))"
            ),
            "gi"
        );

        // Create an array to hold our data. Give the array
        // a default empty first row.
        var arrData: string[][] = [[]];

        // Create an array to hold our individual pattern
        // matching groups.
        var arrMatches: string[] = null;

        // Keep looping over the regular expression matches
        // until we can no longer find a match.
        while (arrMatches = objPattern.exec( strData )){

            // Get the delimiter that was found.
            var strMatchedDelimiter = arrMatches[ 1 ];

            // Check to see if the given delimiter has a length
            // (is not the start of string) and if it matches
            // field delimiter. If id does not, then we know
            // that this delimiter is a row delimiter.
            if (
                strMatchedDelimiter.length &&
                strMatchedDelimiter !== strDelimiter
            ) {

                // Since we have reached a new row of data,
                // add an empty row to our data array.
                arrData.push( [] );

            }

            var strMatchedValue: string;

            // Now that we have our delimiter out of the way,
            // let's check to see which kind of value we
            // captured (quoted or unquoted).
            if (arrMatches[ 2 ]){

                // We found a quoted value. When we capture
                // this value, unescape any double quotes.
                strMatchedValue = arrMatches[ 2 ].replace(
                    new RegExp( "\"\"", "g" ),
                    "\""
                );

            } else {

                // We found a non-quoted value.
                strMatchedValue = arrMatches[ 3 ];

            }


            // Now that we have our value string, let's add
            // it to the data array.
            arrData[ arrData.length - 1 ].push( strMatchedValue );
        }

        // Return the parsed data.
        return arrData;
    }
}